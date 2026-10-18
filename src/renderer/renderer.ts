// The panel UI (SPEC §4.2, Amendment 9: mockup A2): one card per thread, newest first. Each card has a header row
// (thumbnail, title, time); the newest thread's card is open below it — the conversation with rendered answers,
// "Thinking…" until the first text arrives, the streamed answer, Retry on error and a status line — and older
// threads are one-line rows that open in place on click. One composer pinned at the bottom of the window sends
// follow-ups to the newest thread, and the title bar's × hides the window (as Esc does in main). Talks to main only
// through `window.snapsolve` (SPEC §4.4); model output goes through render.ts. On macOS a missing Screen Recording
// grant shows a permission card instead (SPEC §7.1, Amendment 2): its text and Open System Settings / Relaunch,
// nothing else.
import { continuedNote, screenRecordingCard, userMessage } from "../shared/errors";
import type { SnapsolveApi } from "../shared/ipc";
import type { AssistantTurn, Thread } from "../shared/types";
import { renderAnswer } from "./render";

declare global {
  interface Window {
    snapsolve: SnapsolveApi;
  }
}

interface Card {
  kind: "thread";
  root: HTMLElement;
  header: HTMLButtonElement;
  title: HTMLElement;
  time: HTMLElement;
  body: HTMLElement;
  turns: HTMLElement;
  live: HTMLElement;
  retry: HTMLButtonElement;
  status: HTMLElement;
}

const api = window.snapsolve;
const list = document.getElementById("threads") as HTMLElement;
const empty = document.getElementById("empty") as HTMLElement;
const box = document.getElementById("follow-up") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
/** At most this tall before the composer scrolls (about five lines). */
const COMPOSER_MAX_PX = 120;

interface PermissionCard {
  kind: "permission";
  root: HTMLElement;
  message: HTMLElement;
  actions: HTMLElement;
}

const threads = new Map<string, Thread>();
const cards = new Map<string, Card | PermissionCard>();
/** Answer text streamed so far for a thread's running turn. */
const streams = new Map<string, string>();
/** Threads with a follow-up or retry sent whose turn has not ended yet. */
const pending = new Set<string>();
/** Older threads the user opened (the newest is always open). */
const opened = new Set<string>();
/** The newest thread that takes follow-ups: the composer's target; null with no threads. */
let newest: string | null = null;

const BUSY = new Set<Thread["status"]>(["new", "queued", "running"]);
const isBusy = (t: Thread) => BUSY.has(t.status) || pending.has(t.id);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function thumbnail(threadId: string, n: number): HTMLImageElement {
  const img = el("img", "thumb");
  img.alt = `Screenshot ${n}`;
  img.src = `snapsolve://thread/${threadId}/${n}.png`;
  return img;
}

function answerNode(className: string, markdown: string): HTMLElement {
  const node = el("div", className);
  node.innerHTML = renderAnswer(markdown);
  return node;
}

function createCard(thread: Thread): Card {
  const root = el("article", "card");
  root.dataset.threadId = thread.id;
  const header = el("button", "card-header");
  header.type = "button";
  const title = el("span", "card-title");
  const time = el("span", "card-time");
  const text = el("span", "card-text");
  text.append(title, time);
  header.append(thumbnail(thread.id, 1), text);
  const body = el("div", "card-body");
  const turns = el("div", "turns");
  const live = el("div", "live");
  const actions = el("div", "actions");
  const retry = el("button", "retry", "Retry");
  retry.type = "button";
  actions.append(retry);
  const status = el("p", "status");
  body.append(turns, live, actions, status);
  root.append(header, body);

  header.addEventListener("click", () => {
    if (thread.id === newest) return;
    if (opened.has(thread.id)) opened.delete(thread.id);
    else opened.add(thread.id);
    update(thread.id);
  });
  retry.addEventListener("click", () => {
    pending.add(thread.id);
    update(thread.id);
    api.retry(thread.id).catch(() => {
      pending.delete(thread.id);
      update(thread.id);
    });
  });
  return { kind: "thread", root, header, title, time, body, turns, live, retry, status };
}

function createPermissionCard(thread: Thread): PermissionCard {
  const root = el("article", "card permission");
  root.dataset.threadId = thread.id;
  const message = el("p", "error");
  const actions = el("div", "actions");
  root.append(message, actions);
  return { kind: "permission", root, message, actions };
}

/** The buttons follow `prompted`, which can change while the card is shown (a later denied capture). */
function updatePermission(card: PermissionCard, prompted: boolean): void {
  const model = screenRecordingCard(prompted);
  card.message.textContent = model.message;
  const buttons = model.actions.map((action) => {
    const button =
      action === "openSettings" ? el("button", "open-settings", "Open System Settings") : el("button", "relaunch", "Relaunch");
    button.type = "button";
    button.addEventListener("click", () => {
      const done = action === "openSettings" ? api.openScreenRecordingSettings() : api.relaunch();
      done.catch(() => flash(button, "Failed"));
    });
    return button;
  });
  card.actions.replaceChildren(...buttons);
}

function flash(button: HTMLButtonElement, text: string): void {
  const label = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = label), 1200);
}

/** The thread's own title, else the first line of its first answer as plain text, else "Screenshot". */
function titleOf(thread: Thread): string {
  if (thread.title.trim()) return thread.title.trim();
  const answer = thread.turns.find((t): t is AssistantTurn => t.role === "assistant" && !t.isError);
  const line = answer?.text
    .split("\n")
    .map((l) => l.replace(/[*_`#>$\\]/g, "").trim())
    .find(Boolean);
  return line || "Screenshot";
}

/** "Just now", "5 min ago", a time today, else the date and time. */
function timeOf(thread: Thread, now = Date.now()): string {
  const created = new Date(thread.createdAt);
  const minutes = Math.floor((now - created.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const clock = created.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (created.toDateString() === new Date(now).toDateString()) return clock;
  return `${created.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock}`;
}

function renderTurns(card: Card, thread: Thread): void {
  const nodes: Node[] = [];
  let screenshots = 0;
  for (const turn of thread.turns) {
    if (turn.role === "user") {
      const note = continuedNote(turn);
      if (note) nodes.push(el("p", "note", note));
      // The first screenshot is the card's thumbnail; appended ones show where they joined.
      if (turn.kind === "screenshot") {
        if (++screenshots > 1) nodes.push(thumbnail(thread.id, Number.parseInt(turn.file, 10)));
      } else {
        nodes.push(el("p", "question", turn.text));
      }
    } else if (turn.isError) {
      if (turn.warning) nodes.push(el("p", "warning", userMessage(turn.warning)));
      if (turn.text) nodes.push(answerNode("partial", turn.text));
      nodes.push(el("p", "error", turn.errorMessage ?? userMessage(turn.errorKind ?? "internal")));
    } else {
      if (turn.warning) nodes.push(el("p", "warning", userMessage(turn.warning)));
      if (turn.note === "resumeFallback") nodes.push(el("p", "note", userMessage("resumeFailed")));
      nodes.push(answerNode("answer", turn.text));
    }
  }
  card.turns.replaceChildren(...nodes);
}

function renderLive(card: Card, thread: Thread): void {
  const streamed = streams.get(thread.id);
  if (!isBusy(thread)) card.live.replaceChildren();
  else if (streamed) card.live.replaceChildren(answerNode("answer streaming", streamed));
  else card.live.replaceChildren(el("p", "thinking", thread.status === "queued" ? "Queued…" : "Thinking…"));
}

function statusLine(thread: Thread): string {
  const turn = thread.turns.filter((t): t is AssistantTurn => t.role === "assistant").at(-1);
  const parts = [thread.model];
  if (turn?.ttftMs != null) parts.push(`TTFT ${(turn.ttftMs / 1000).toFixed(1)} s`);
  if (turn) parts.push(`${(turn.durationMs / 1000).toFixed(1)} s`);
  if (turn?.usage) parts.push(turn.usage);
  return parts.join(" · ");
}

function update(threadId: string): void {
  const thread = threads.get(threadId);
  const card = cards.get(threadId);
  if (!thread || !card) return;
  if (card.kind === "permission") {
    updatePermission(card, thread.permission?.prompted ?? false);
    return;
  }
  const open = thread.id === newest || opened.has(thread.id);
  card.root.classList.toggle("older", thread.id !== newest);
  card.root.classList.toggle("collapsed", !open);
  card.header.setAttribute("aria-expanded", String(open));
  card.body.hidden = !open;
  card.title.textContent = titleOf(thread);
  card.time.textContent = timeOf(thread);
  renderTurns(card, thread);
  renderLive(card, thread);
  const busy = isBusy(thread);
  const last = thread.turns.at(-1);
  card.retry.hidden = busy || thread.status !== "error";
  // A thread that failed before claude ran has no errored turn: say so on the card.
  if (!busy && thread.status === "error" && !(last?.role === "assistant" && last.isError)) {
    card.live.replaceChildren(el("p", "error", userMessage("internal")));
  }
  card.status.textContent = statusLine(thread);
}

function updateComposer(): void {
  box.disabled = newest === null;
  send.disabled = newest === null || box.value.trim() === "";
}

/** Puts the cards in newest-first order, moving only those out of place (a moved node would lose focus). */
function layout(): void {
  const order = [...threads.values()].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  );
  for (const [id, card] of cards) {
    if (!threads.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  newest = order.find((t) => !t.permission)?.id ?? null;
  for (const id of [...opened]) if (!threads.has(id) || id === newest) opened.delete(id);
  let previous: Element | null = null;
  for (const thread of order) {
    let card = cards.get(thread.id);
    if (!card) {
      card = thread.permission ? createPermissionCard(thread) : createCard(thread);
      cards.set(thread.id, card);
    }
    const want: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
    if (want !== card.root) list.insertBefore(card.root, want);
    previous = card.root;
    update(thread.id);
  }
  empty.hidden = threads.size > 0;
  updateComposer();
}

function setThreads(next: Thread[]): void {
  threads.clear();
  for (const t of next) threads.set(t.id, t);
  for (const id of [...streams.keys()]) if (!threads.has(id)) streams.delete(id);
  layout();
}

api.onThreadsChanged(setThreads);
api.onDelta(({ threadId, text }) => {
  streams.set(threadId, (streams.get(threadId) ?? "") + text);
  const thread = threads.get(threadId);
  const card = cards.get(threadId);
  if (thread && card?.kind === "thread") renderLive(card, thread);
});
api.onDone(({ threadId, thread }) => {
  streams.delete(threadId);
  pending.delete(threadId);
  threads.set(threadId, thread);
  layout();
});

function sendFollowUp(): void {
  const threadId = newest;
  const text = box.value.trim();
  if (!threadId || !text) return;
  box.value = "";
  fitComposer();
  pending.add(threadId);
  update(threadId);
  api.followUp(threadId, text).catch(() => {
    box.value = text;
    fitComposer();
    pending.delete(threadId);
    update(threadId);
  });
}

/** Grows the composer with its text, up to COMPOSER_MAX_PX. */
function fitComposer(): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, COMPOSER_MAX_PX)}px`;
  updateComposer();
}

box.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendFollowUp();
});
box.addEventListener("input", fitComposer);
send.addEventListener("click", sendFollowUp);
(document.getElementById("hide") as HTMLButtonElement).addEventListener("click", () => void api.hide().catch(() => undefined));
// Relative times ("5 min ago") move on while the window is up.
setInterval(() => {
  for (const [id, card] of cards) {
    const thread = threads.get(id);
    if (thread && card.kind === "thread") card.time.textContent = timeOf(thread);
  }
}, 60_000);

// Links in answers open in the browser, via main's http(s) check; the panel itself never navigates.
document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!link) return;
  event.preventDefault();
  void api.openExternal((link as HTMLAnchorElement).href).catch(() => undefined);
});

void api.listThreads().then(setThreads, () => setThreads([]));
