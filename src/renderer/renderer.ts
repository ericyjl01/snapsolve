// The panel UI (SPEC §4.2, Amendments 9–10: mockup A2): one card per thread, newest first. Each card has a header
// row (thumbnail, title, time); the newest thread's card is open below it — the conversation with rendered answers,
// "Thinking…" until the first text arrives, the streamed answer, Retry on error and a status line — and older
// threads are one-line rows that open in place on click. One composer pinned at the bottom of the window sends
// follow-ups to the newest thread. The title bar's "+" starts a new chat: every card becomes a row until the next
// capture or typed question starts a thread (the composer then starts a text thread). Its × hides the window (as
// Esc does in main). Talks to main only
// through `window.snapsolve` (SPEC §4.4); model output goes through render.ts. On macOS a missing Screen Recording
// grant shows a permission card instead (SPEC §7.1, Amendment 2): its text and Open System Settings / Relaunch,
// nothing else; voice's refused Microphone or Speech Recognition does the same with Open System Settings only. While
// a question is dictated (Amendment 11, task 063) the composer is a listening bar: a red dot, input level bars, the
// live transcript and how to send or cancel; a dictated question shows with a mic mark.
import { continuedNote, screenRecordingCard, userMessage, voicePermissionCard } from "../shared/errors";
import type { SnapsolveApi } from "../shared/ipc";
import type { AssistantTurn, Thread, UserTurn, VoiceState } from "../shared/types";
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
  thumb: HTMLImageElement;
  /** The header thumbnail did not load: a thread that began with a typed question has no first screenshot. */
  thumbMissing: boolean;
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
const composerBox = document.getElementById("composer-box") as HTMLElement;
const listening = document.getElementById("listening") as HTMLElement;
const voiceNote = document.getElementById("voice-note") as HTMLElement;
/** At most this tall before the composer scrolls (about five lines). */
const COMPOSER_MAX_PX = 120;
/** How long a voice note ("Didn't catch that.") stays under the composer. */
const VOICE_NOTE_MS = 4_000;

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
/** The newest thread that takes follow-ups: the composer's target; null with no threads or after "+". */
let newest: string | null = null;
/** The newest thread on screen (whether or not "+" was clicked). */
let top: string | null = null;
/** Set by "+": `top` when it was clicked; cleared once another thread is on top. Undefined: not a new chat. */
let freshAfter: string | null | undefined;

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
  const thumb = thumbnail(thread.id, 1);
  header.append(thumb, text);
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
  const card: Card = { kind: "thread", root, header, thumb, thumbMissing: false, title, time, body, turns, live, retry, status };
  thumb.addEventListener("error", () => {
    card.thumbMissing = true;
    thumb.hidden = true;
  });

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
  return card;
}

function createPermissionCard(thread: Thread): PermissionCard {
  const root = el("article", "card permission");
  root.dataset.threadId = thread.id;
  const message = el("p", "error");
  const actions = el("div", "actions");
  root.append(message, actions);
  return { kind: "permission", root, message, actions };
}

/**
 * Screen Recording: the buttons follow `prompted`, which can change while the card is shown (a later denied capture).
 * Voice: the refused permission, and Open System Settings at its pane.
 */
function updatePermission(card: PermissionCard, permission: NonNullable<Thread["permission"]>): void {
  const voice = "voice" in permission;
  const model = voice ? voicePermissionCard(permission.voice) : screenRecordingCard(permission.prompted);
  card.message.textContent = model.message;
  const buttons = model.actions.map((action) => {
    const button =
      action === "openSettings" ? el("button", "open-settings", "Open System Settings") : el("button", "relaunch", "Relaunch");
    button.type = "button";
    button.addEventListener("click", () => {
      const done =
        action === "relaunch" ? api.relaunch() : voice ? api.openVoiceSettings() : api.openScreenRecordingSettings();
      done.catch(() => flash(button, "Failed"));
    });
    return button;
  });
  card.actions.replaceChildren(...buttons);
}

/** The small mic shown before a dictated question. */
function micMark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "mic-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "11");
  svg.setAttribute("viewBox", "0 0 12 14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  const body = document.createElementNS(ns, "rect");
  for (const [k, v] of Object.entries({ x: "3.5", y: "1", width: "5", height: "8", rx: "2.5" })) body.setAttribute(k, v);
  const stand = document.createElementNS(ns, "path");
  stand.setAttribute("d", "M1.5 6.5a4.5 4.5 0 0 0 9 0M6 11v2");
  svg.append(body, stand);
  return svg;
}

function flash(button: HTMLButtonElement, text: string): void {
  const label = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = label), 1200);
}

/** The thread's own title, else the first line of its first answer as plain text, else its first question, else "Screenshot". */
function titleOf(thread: Thread): string {
  if (thread.title.trim()) return thread.title.trim();
  const answer = thread.turns.find((t): t is AssistantTurn => t.role === "assistant" && !t.isError);
  const line = answer?.text
    .split("\n")
    .map((l) => l.replace(/[*_`#>$\\]/g, "").trim())
    .find(Boolean);
  const asked = firstUserTurn(thread);
  return line || (asked?.kind === "text" ? asked.text.trim() : "") || "Screenshot";
}

function firstUserTurn(thread: Thread): UserTurn | undefined {
  return thread.turns.find((t): t is UserTurn => t.role === "user");
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
  const first = firstUserTurn(thread);
  for (const turn of thread.turns) {
    if (turn.role === "user") {
      const note = continuedNote(turn);
      if (note) nodes.push(el("p", "note", note));
      // A thread's opening screenshot is the card's thumbnail; later ones show where they joined.
      if (turn.kind === "screenshot") {
        if (turn !== first) nodes.push(thumbnail(thread.id, Number.parseInt(turn.file, 10)));
      } else if (turn.voice) {
        const asked = el("p", "question voice");
        asked.title = "Dictated";
        asked.append(micMark(), document.createTextNode(turn.text));
        nodes.push(asked);
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
    updatePermission(card, thread.permission ?? { prompted: false });
    return;
  }
  const open = thread.id === newest || opened.has(thread.id);
  card.root.classList.toggle("older", thread.id !== newest);
  card.root.classList.toggle("collapsed", !open);
  card.header.setAttribute("aria-expanded", String(open));
  card.thumb.hidden = card.thumbMissing || firstUserTurn(thread)?.kind === "text";
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
  box.placeholder = newest === null ? "Ask a new question" : "Ask a follow-up";
  send.disabled = box.value.trim() === "";
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
  top = order.find((t) => !t.permission)?.id ?? null;
  if (freshAfter !== undefined && top !== freshAfter) freshAfter = undefined;
  newest = freshAfter === undefined ? top : null;
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
  empty.textContent =
    threads.size === 0 ? "Press the snapsolve hotkey to solve what's on your screen." : "New chat. Press the snapsolve hotkey or type a question.";
  // Shown with no threads at all, and after "+" until the new thread arrives.
  empty.hidden = threads.size > 0 && freshAfter === undefined;
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

/** A follow-up to the newest thread; with none (no threads, or after "+") a new text thread. */
function sendFollowUp(): void {
  const threadId = newest;
  const text = box.value.trim();
  if (!text) return;
  box.value = "";
  fitComposer();
  if (!threadId) {
    api.newThread(text).catch(() => {
      box.value = text;
      fitComposer();
    });
    return;
  }
  pending.add(threadId);
  update(threadId);
  api.followUp(threadId, text).catch(() => {
    box.value = text;
    fitComposer();
    pending.delete(threadId);
    update(threadId);
  });
}

let noteTimer: ReturnType<typeof setTimeout> | undefined;

/** The composer while dictating: the listening bar instead of the text box; back to it when idle, with a note. */
function showVoice(state: VoiceState): void {
  clearTimeout(noteTimer);
  const active = state.state !== "idle";
  composerBox.hidden = active;
  listening.hidden = !active;
  listening.classList.toggle("stopping", state.state === "stopping");
  voiceNote.hidden = true;
  if (state.state === "idle") {
    if (state.note) {
      voiceNote.textContent = state.note;
      voiceNote.hidden = false;
      noteTimer = setTimeout(() => (voiceNote.hidden = true), VOICE_NOTE_MS);
    }
    return;
  }
  (listening.querySelector(".transcript") as HTMLElement).textContent = state.text || "Listening…";
  (listening.querySelector(".hint") as HTMLElement).textContent =
    state.state === "listening" ? `${state.key} to send · esc to cancel` : "Sending…";
  const level = state.state === "listening" ? state.level : 0;
  // Five bars, the middle ones tallest, scaled by the input level.
  const shape = [0.5, 0.8, 1, 0.8, 0.5];
  listening.querySelectorAll<HTMLElement>(".level").forEach((bar, i) => {
    bar.style.height = `${Math.round(3 + 11 * level * shape[i])}px`;
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
// The mic buttons (title bar and composer) do what the voice hotkey does: start, and again stop and send.
for (const id of ["voice", "composer-voice"]) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => void api.toggleVoice().catch(() => undefined));
}
api.onVoice(showVoice);
(document.getElementById("hide") as HTMLButtonElement).addEventListener("click", () => void api.hide().catch(() => undefined));
// "+": main starts the next capture or question in a new thread; here every card becomes a row until it arrives.
(document.getElementById("new-chat") as HTMLButtonElement).addEventListener("click", () => {
  const was = freshAfter;
  freshAfter = top;
  layout();
  api.newThread().catch(() => {
    freshAfter = was;
    layout();
  });
});
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
