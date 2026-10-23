// The panel UI (SPEC §4.2, Amendments 9–10 and 15: mockup A2, then the chat layout of task 078): one chat on screen —
// its screenshots, questions and rendered answers, "Thinking…" until the first text arrives, the streamed answer,
// Retry on error and a status line — and every chat in the "Chats" sidebar, newest first under Today / Yesterday /
// Previous 7 days / Older. Below 600 px the sidebar is an overlay over a scrim and starts closed; wider it is docked
// beside the chat and starts open. Choosing a chat shows it and tells main (openThread), so the composer and the next
// capture continue it; a new chat (a capture after "+", a typed question, a seeded continuation) is shown as it
// arrives. One composer pinned at the bottom sends follow-ups to the chat on screen. The title bar's "+" (and the
// sidebar's New chat) starts a new chat: the main area is empty until the next capture or typed question starts a
// thread (the composer then starts a text thread). Its × hides the window (as Esc does in main). Talks to main only
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
const sidebar = document.getElementById("sidebar") as HTMLElement;
const chatList = document.getElementById("chats") as HTMLElement;
const scrim = document.getElementById("scrim") as HTMLElement;
const showChats = document.getElementById("sidebar-show") as HTMLButtonElement;
const chatTitle = document.getElementById("chat-title") as HTMLElement;
/** At this width and wider the sidebar is docked beside the chat; narrower it is an overlay (078). */
const wide = window.matchMedia("(min-width: 600px)");
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
/** The chat the user is on: the newest until another is chosen in the sidebar; a newer chat arriving replaces it. */
let current: string | null = null;
/** The chat on screen and the composer's target: `current`, or null with no threads or after "+". */
let shown: string | null = null;
/** The newest chat (permission cards aside), whether or not "+" was clicked. */
let top: string | null = null;
/** `top` at the previous layout; undefined before the first. A change means a new chat arrived. */
let lastTop: string | null | undefined;
/** Set by "+": `top` when it was clicked; cleared once another thread is on top. Undefined: not a new chat. */
let freshAfter: string | null | undefined;
/** The sidebar is shown: docked (wide) or over the chat (narrow). */
let sidebarOpen = wide.matches;
/** The user closed the sidebar (082): it stays closed through resizes until Show chats. */
let sidebarClosedByUser = false;

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
  img.addEventListener("error", () => (img.hidden = true));
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
  const retry = el("button", "retry", "Retry");
  retry.type = "button";
  actions.append(retry);
  const status = el("p", "status");
  root.append(turns, live, actions, status);
  const card: Card = { kind: "thread", root, turns, live, retry, status };
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

/** The sidebar's group for a chat started at `createdAt` (local calendar days). */
function groupOf(createdAt: string, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(new Date(createdAt))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

function renderTurns(card: Card, thread: Thread): void {
  const nodes: Node[] = [];
  for (const turn of thread.turns) {
    if (turn.role === "user") {
      const note = continuedNote(turn);
      if (note) nodes.push(el("p", "note", note));
      // Every screenshot shows where it joined the chat, the first one too.
      if (turn.kind === "screenshot") {
        nodes.push(thumbnail(thread.id, Number.parseInt(turn.file, 10)));
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
  box.placeholder = shown === null ? "Ask anything" : "Ask a follow-up";
  send.disabled = box.value.trim() === "";
}

/** The sidebar's rows: every chat newest first under its day group, the one on screen marked current. */
function renderChats(order: Thread[]): void {
  const nodes: Node[] = [];
  let group = "";
  for (const thread of order) {
    const g = groupOf(thread.createdAt);
    if (g !== group) {
      nodes.push(el("p", "chat-group", g));
      group = g;
    }
    const row = el("button", "chat");
    row.type = "button";
    row.dataset.chatId = thread.id;
    if (thread.id === shown) row.setAttribute("aria-current", "true");
    const dot = el("span", `chat-dot${isBusy(thread) ? " busy" : thread.status === "error" ? " error" : ""}`);
    dot.setAttribute("aria-hidden", "true");
    row.append(dot, el("span", "chat-name", titleOf(thread)));
    row.addEventListener("click", () => chooseChat(thread.id));
    nodes.push(row);
  }
  chatList.replaceChildren(...nodes);
}

/** Shows or hides the sidebar: docked when wide, an overlay over the scrim when narrow (078). */
function applySidebar(): void {
  sidebar.hidden = !sidebarOpen;
  scrim.hidden = !(sidebarOpen && !wide.matches);
  // Docked and open, the sidebar's own toggle hides it; the title bar's shows it again.
  showChats.hidden = sidebarOpen && wide.matches;
}

function setSidebar(open: boolean): void {
  sidebarOpen = open;
  applySidebar();
}

/** The user opens or closes the sidebar (082): a close outlasts resizes until Show chats. */
function chooseSidebar(open: boolean): void {
  sidebarClosedByUser = !open;
  setSidebar(open);
}

/** A chat chosen in the sidebar: on screen at once, and main continues it on the next capture. */
function chooseChat(threadId: string): void {
  current = threadId;
  freshAfter = undefined;
  if (!wide.matches && sidebarOpen) chooseSidebar(false);
  layout();
  api.openThread(threadId).catch(() => undefined);
}

/** "+" and the sidebar's New chat: main starts the next capture or question in a new thread; until then nothing is on screen. */
function startNewChat(): void {
  const was = freshAfter;
  freshAfter = top;
  if (!wide.matches && sidebarOpen) chooseSidebar(false);
  layout();
  api.newThread().catch(() => {
    freshAfter = was;
    layout();
  });
}

/** Every thread, newest first (createdAt, then id: main's order). */
function newestFirst(): Thread[] {
  return [...threads.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

/** The chat on screen (with any permission card above it) and the sidebar, newest first. */
function layout(): void {
  const order = newestFirst();
  const chatsOnly = order.filter((t) => !t.permission);
  top = chatsOnly[0]?.id ?? null;
  if (freshAfter !== undefined && top !== freshAfter) freshAfter = undefined;
  // A new chat arrived (or this is the first listing): show it. A chat that went away gives way to the newest.
  if (top !== lastTop || (current !== null && !threads.has(current))) current = top;
  lastTop = top;
  shown = freshAfter === undefined ? current : null;
  const visible = order.filter((t) => t.permission || t.id === shown);
  const keep = new Set(visible.map((t) => t.id));
  for (const [id, card] of cards) {
    if (!keep.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  // Moves only the cards out of place (a moved node would lose focus).
  let previous: Element | null = null;
  for (const thread of visible) {
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
  empty.hidden = shown !== null || (threads.size > 0 && freshAfter === undefined);
  const onScreen = shown === null ? undefined : threads.get(shown);
  chatTitle.textContent = onScreen ? titleOf(onScreen) : "New chat";
  renderChats(chatsOnly);
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

/** A follow-up to the chat on screen; with none (no threads, or after "+") a new text thread. */
function sendFollowUp(): void {
  const threadId = shown;
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
(document.getElementById("new-chat") as HTMLButtonElement).addEventListener("click", startNewChat);
(document.getElementById("sidebar-new") as HTMLButtonElement).addEventListener("click", startNewChat);
showChats.addEventListener("click", () => chooseSidebar(true));
(document.getElementById("sidebar-hide") as HTMLButtonElement).addEventListener("click", () => chooseSidebar(false));
scrim.addEventListener("click", () => chooseSidebar(false));
// Crossing 600 px: docked and open when wide unless the user closed it (082), a closed overlay when narrow.
wide.addEventListener("change", () => setSidebar(wide.matches && !sidebarClosedByUser));
applySidebar();
// The day groups (Today, Yesterday…) move on while the window is up.
setInterval(() => renderChats(newestFirst().filter((t) => !t.permission)), 60_000);

// Links in answers open in the browser, via main's http(s) check; the panel itself never navigates.
document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!link) return;
  event.preventDefault();
  void api.openExternal((link as HTMLAnchorElement).href).catch(() => undefined);
});

void api.listThreads().then(setThreads, () => setThreads([]));
