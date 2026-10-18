// The panel UI (SPEC §4.2): one card per thread, newest first — thumbnail, the conversation with rendered answers,
// "Thinking…" until the first text arrives, the streamed answer, Copy (Markdown), Retry on error, a follow-up box
// and a status line. Talks to main only through `window.snapsolve` (SPEC §4.4); model output goes through render.ts.
// No × button yet (061): Esc in main hides the window (SPEC Amendments 3 and 8). On macOS a missing Screen
// Recording grant shows a permission card instead (SPEC §7.1, Amendment 2): its text and Open System Settings /
// Relaunch, nothing else.
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
  turns: HTMLElement;
  live: HTMLElement;
  retry: HTMLButtonElement;
  copy: HTMLButtonElement;
  box: HTMLTextAreaElement;
  status: HTMLElement;
}

const api = window.snapsolve;
const list = document.getElementById("threads") as HTMLElement;
const empty = document.getElementById("empty") as HTMLElement;

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
  const turns = el("div", "turns");
  const live = el("div", "live");
  const actions = el("div", "actions");
  const copy = el("button", "copy", "Copy");
  copy.type = "button";
  const retry = el("button", "retry", "Retry");
  retry.type = "button";
  actions.append(copy, retry);
  const box = el("textarea", "follow-up");
  box.rows = 2;
  box.placeholder = "Ask a follow-up (Enter to send, Shift+Enter for a new line)";
  const status = el("p", "status");
  root.append(thumbnail(thread.id, 1), turns, live, actions, box, status);

  copy.addEventListener("click", () => {
    const answer = lastAnswer(threads.get(thread.id));
    if (answer) void api.copy(answer.text).then(() => flash(copy, "Copied"), () => flash(copy, "Copy failed"));
  });
  retry.addEventListener("click", () => {
    pending.add(thread.id);
    update(thread.id);
    api.retry(thread.id).catch(() => {
      pending.delete(thread.id);
      update(thread.id);
    });
  });
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    pending.add(thread.id);
    update(thread.id);
    api.followUp(thread.id, text).catch(() => {
      box.value = text;
      pending.delete(thread.id);
      update(thread.id);
    });
  });
  return { kind: "thread", root, turns, live, retry, copy, box, status };
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

function lastAnswer(thread: Thread | undefined): AssistantTurn | undefined {
  return thread?.turns.filter((t): t is AssistantTurn => t.role === "assistant" && !t.isError).at(-1);
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
  renderTurns(card, thread);
  renderLive(card, thread);
  const busy = isBusy(thread);
  const last = thread.turns.at(-1);
  card.retry.hidden = busy || thread.status !== "error";
  // A thread that failed before claude ran has no errored turn: say so on the card.
  if (!busy && thread.status === "error" && !(last?.role === "assistant" && last.isError)) {
    card.live.replaceChildren(el("p", "error", userMessage("internal")));
  }
  card.copy.hidden = !lastAnswer(thread);
  card.status.textContent = statusLine(thread);
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

// Links in answers open in the browser, via main's http(s) check; the panel itself never navigates.
document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!link) return;
  event.preventDefault();
  void api.openExternal((link as HTMLAnchorElement).href).catch(() => undefined);
});

void api.listThreads().then(setThreads, () => setThreads([]));
