// The capture → store → runner → panel pipeline (SPEC §2.1, §3.5, §4.2, Amendment 10): a capture joins the current
// thread (the newest; after a restart the newest on disk) and starts a new one when there is none, after "+"
// (`newThread`) or past the screenshot limit. The window is shown as soon as the screen is grabbed, the card says
// "Thinking…" while the screenshot is made and saved (task 088), and both happen before claude is spawned. Runner
// events and the renderer's requests (SPEC §4.4) are relayed between runner and panel.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { screenRecordingCard, SnapsolveError, userMessage, voicePermissionCard } from "../shared/errors";
import { IPC, type IpcEvents } from "../shared/ipc";
import type { AssistantTurn, Config, Theme, Thread, ThreadStatus, VoiceCardKind, VoiceDenial } from "../shared/types";
import { formatUsage } from "./auth";
import { decideAppend } from "./capture";
import type { Logger } from "./log";
import { isSafeExternalUrl } from "./panel";
import { type Command, retryTarget, type Runner, type RunnerEvent, type TurnOutcome, type TurnRequest } from "./runner";
import { isUuid, type SavedScreenshot, type Store } from "./store";

export interface AppDeps {
  store: Store;
  runner: Pick<Runner, "enqueue" | "on">;
  panel: { open(): void; send<C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]): void };
  config: Pick<Config, "model" | "effort" | "maxScreenshotsPerThread">;
  log: Logger;
  /** `shell.openExternal`; only ever called with an http(s) URL. */
  openExternal: (url: string) => Promise<void>;
  /** The native confirm dialog before clearing history; true = go ahead. */
  confirmClearHistory: () => Promise<boolean>;
  /** Called after every turn ends (the panel's auto-hide countdown). */
  onTurnEnded?: () => void;
  /** The usage line ("5h N% · 7d M%") from every `rate_limit_event`: the tray tooltip (SPEC §3.6). */
  onUsage?: (usage: string) => void;
  /** The capturer's monotonic clock in ms (`performance.now` by default), for the `capture.timing` line (088). */
  now?: () => number;
}

/** A capture (`Screenshot` from capture.ts, or a test fixture) whose PNG is made when `encode` is called (088). */
export interface Shot {
  /** `now()` when the capture was asked for. */
  startedAt: number;
  grabMs: number;
  encode(): { png: Uint8Array; pngMs: number; encodeMs: number };
}

export type AppHandlers = {
  listThreads(): Promise<Thread[]>;
  followUp(threadId: string, text: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  /** "+": no text → the next capture or question starts a new thread; text → a new text thread with it now. */
  newThread(text?: string): Promise<void>;
  /** A chat chosen in the sidebar (078): the next capture or dictation continues it; an unknown id changes nothing. */
  openThread(threadId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  clearHistory(): Promise<boolean>;
};

export interface App {
  /**
   * Shows the window at once (088), then joins the current thread; a new thread when there is none, after "+", or
   * when it is full (SPEC §2.3, seeded). Resolves with the thread's id once the turn is queued, or once a screenshot
   * that could not be saved shows the capture error in that chat.
   */
  onCapture(shot: Shot): Promise<string>;
  /**
   * macOS: a capture refused for want of the Screen Recording grant (SPEC §7.1). Opens the panel on one unsaved card
   * that says what to do; a later denial updates it, the next capture that works removes it.
   */
  onCaptureDenied(prompted: boolean): Promise<void>;
  /**
   * A dictated question (task 063): where a typed one would go — a follow-up to the current thread, or a new text
   * thread when there is none or after "+". Marked as dictated. Resolves with the thread's id once it is queued.
   */
  onVoice(text: string): Promise<string>;
  /** Voice was refused a permission: one unsaved card that says which to turn on; a dictation that works removes it. */
  onVoiceDenied(denial: VoiceDenial): Promise<void>;
  /** The speech helper failed: the same card slot, saying so. */
  onVoiceFailed(): Promise<void>;
  /** The thread a capture or question would join is new, queued or running (a voice press is then ignored, 063). */
  isAnswering(): boolean;
  /** The renderer's requests (arguments come from the renderer, so each is checked). */
  handlers: AppHandlers;
}

export function createApp(deps: AppDeps): App {
  const { store, runner, panel, config, log } = deps;
  const now = deps.now ?? (() => performance.now());
  /** The thread a capture joins; undefined until known (then the newest on disk), null when there is none. */
  let current: string | null | undefined;
  /** "+" was clicked: the next capture or question starts a new thread. */
  let fresh = false;
  // The threads as the renderer should see them: disk at first listing, then every change in event order. Re-reading
  // disk after an event could deliver a snapshot older than an answer:done already sent.
  const known = new Map<string, Thread>();
  /** The Screen Recording card's id while it is shown; it lives only in `known`. */
  let permissionId: string | null = null;
  /** The voice permission card's id while it is shown (task 063); also only in `known`. */
  let voiceCardId: string | null = null;
  /** New chats whose first screenshot could not be saved (088): the next capture into one is its first turn. */
  const unstarted = new Set<string>();

  function remember(thread: Thread): void {
    known.set(thread.id, thread);
  }

  function broadcast(): void {
    panel.send(IPC.threadsChanged, snapshot());
  }

  function snapshot(): Thread[] {
    return byNewest([...known.values()]);
  }

  /** Applies `patch` to a thread this app has seen; one it has not is read from disk first. */
  async function patchThread(threadId: string, patch: Partial<Thread>): Promise<void> {
    let thread = known.get(threadId);
    if (!thread) {
      try {
        thread = await store.getThread(threadId);
      } catch (e) {
        log.warn("app.threadUnreadable", { threadId, error: e });
        return;
      }
    }
    remember({ ...(known.get(threadId) ?? thread), ...patch });
    broadcast();
  }

  runner.on((event: RunnerEvent) => {
    switch (event.type) {
      case "delta":
        panel.send(IPC.answerDelta, { threadId: event.threadId, text: event.text });
        return;
      case "status":
        void patchThread(event.threadId, { status: event.status });
        return;
      case "turn":
        remember(event.thread);
        broadcast();
        return;
      case "done":
        remember(event.thread);
        panel.send(IPC.answerDone, { threadId: event.threadId, thread: event.thread });
        deps.onTurnEnded?.();
        return;
      case "error":
        if (event.thread) {
          remember(event.thread);
          panel.send(IPC.answerDone, { threadId: event.threadId, thread: event.thread });
        } else {
          void patchThread(event.threadId, { status: "error" });
        }
        deps.onTurnEnded?.();
        return;
      case "rateLimit":
        deps.onUsage?.(formatUsage(event));
        return;
      default:
        return;
    }
  });

  /** Queues a turn; its outcome is logged, never awaited by the caller (the card shows it). */
  function start(threadId: string, request: TurnRequest): void {
    runner.enqueue(threadId, request).then(
      (outcome: TurnOutcome) => {
        if (!outcome.ok) log.info("app.turnFailed", { threadId, kind: outcome.kind });
      },
      (e: unknown) => log.error("app.enqueueFailed", { threadId, error: e }),
    );
  }

  /** A capture worked: the Screen Recording card has done its job. */
  function dropPermissionCard(): void {
    if (permissionId) known.delete(permissionId);
    permissionId = null;
  }

  /**
   * Makes and saves a capture's PNG once the window is shown (088) and logs `capture.timing`. When that fails, the
   * chat shows the capture error where "Thinking…" was (a panel-only turn; a status this capture set goes back to
   * `idle`) and null is returned.
   */
  async function saveShot(threadId: string, shot: Shot, shownMs: number, idle: ThreadStatus): Promise<SavedScreenshot | null> {
    try {
      const { png, pngMs, encodeMs } = shot.encode();
      const saveStart = now();
      // SPEC §2.1: the full-resolution PNG is on disk before anything is sent.
      const saved = await store.saveScreenshot(threadId, png);
      const saveMs = now() - saveStart;
      log.info("capture.timing", { grabMs: wholeMs(shot.grabMs), pngMs: wholeMs(pngMs), encodeMs: wholeMs(encodeMs), saveMs: wholeMs(saveMs), shownMs: wholeMs(shownMs) });
      return saved;
    } catch (e) {
      log.warn("app.screenshotNotSaved", { threadId, error: e });
      const thread = known.get(threadId);
      if (thread) {
        const status = thread.status === "new" ? idle : thread.status;
        remember({ ...thread, status, turns: [...thread.turns, errorTurn("captureFailed", userMessage("captureFailed"))] });
        broadcast();
      }
      return null;
    }
  }

  /** `seed`: the previous thread's last answer, when an append past the screenshot limit starts this one (SPEC §2.3). */
  async function newThread(shot: Shot, shownMs: number, seed?: string): Promise<string> {
    const thread = await store.createThread({ model: config.model, effort: config.effort });
    dropPermissionCard();
    current = thread.id;
    remember(thread);
    // SPEC §4.2: the card ("Thinking…") is on screen before claude is spawned.
    broadcast();
    const saved = await saveShot(thread.id, shot, shownMs, "done");
    if (!saved) {
      unstarted.add(thread.id);
      // Not busy on disk either, so a restart does not bring it back as an error card with nothing to retry.
      await store.updateThread(thread.id, { status: "done" }).catch((e: unknown) => log.warn("app.threadNotUpdated", { threadId: thread.id, error: e }));
      return thread.id;
    }
    start(thread.id, { kind: "new", screenshot: saved.file, ...(seed !== undefined ? { seed } : {}) });
    return thread.id;
  }

  /** The thread a capture joins, or null for a new one. */
  async function currentThread(): Promise<Thread | null> {
    if (fresh) return null;
    if (current === undefined) {
      try {
        current = byNewest(await store.listThreads())[0]?.id ?? null;
      } catch (e) {
        log.warn("app.threadsUnlisted", { error: e });
        current = null;
      }
    }
    if (current === null) return null;
    return store.getThread(current).catch(() => null);
  }

  /** A new thread whose first turn is a question (typed after "+", or dictated with no current thread). */
  async function textThread(request: Extract<TurnRequest, { kind: "followUp" }>): Promise<string> {
    const thread = await store.createThread({ model: config.model, effort: config.effort });
    current = thread.id;
    fresh = false;
    remember(thread);
    panel.open();
    broadcast();
    // The runner takes a follow-up as an empty thread's first turn: a new session with the text alone.
    start(thread.id, request);
    return thread.id;
  }

  /** A permission card: a panel-only thread whose one errored turn says what to do. */
  function permissionCard(id: string, title: string, errorKind: AssistantTurn["errorKind"], errorMessage: string, permission: Thread["permission"]): Thread {
    return {
      id,
      sessionId: id,
      transcriptPath: null,
      model: config.model,
      effort: config.effort,
      createdAt: new Date().toISOString(),
      title,
      status: "error",
      turns: [errorTurn(errorKind, errorMessage)],
      permission,
    };
  }

  /** The voice card (one at a time): a refused permission, or the helper failing. */
  async function voiceCard(kind: VoiceCardKind): Promise<void> {
    voiceCardId ??= randomUUID();
    const title = kind === "microphone" ? "Microphone" : kind === "speechRecognition" ? "Speech Recognition" : "Voice input";
    const errorKind = kind === "microphone" ? "microphoneDenied" : kind === "speechRecognition" ? "speechDenied" : "voiceFailed";
    remember(permissionCard(voiceCardId, title, errorKind, voicePermissionCard(kind).message, { voice: kind }));
    panel.open();
    broadcast();
  }

  async function threadOf(threadId: unknown): Promise<Thread> {
    if (!isUuid(threadId)) throw new SnapsolveError("threadNotFound", "invalid thread id");
    return store.getThread(threadId);
  }

  const handlers: AppHandlers = {
    async listThreads() {
      for (const thread of await store.listThreads()) if (!known.has(thread.id)) remember(thread);
      return snapshot();
    },

    async followUp(threadId, text) {
      if (typeof text !== "string" || text.trim() === "") throw new SnapsolveError("internal", "empty follow-up");
      const thread = await threadOf(threadId);
      start(thread.id, { kind: "followUp", text });
    },

    async retry(threadId) {
      const thread = await threadOf(threadId);
      if (thread.status !== "error") {
        log.info("app.retryIgnored", { threadId: thread.id, status: thread.status });
        return;
      }
      if (!retryTarget(thread)) {
        log.warn("app.retryNothing", { threadId: thread.id });
        return;
      }
      // The runner re-runs the failed turn in place: no second copy of its user turn (task 050).
      start(thread.id, { kind: "retry" });
    },

    async newThread(text) {
      if (text === undefined) {
        fresh = true;
        return;
      }
      if (typeof text !== "string" || text.trim() === "") throw new SnapsolveError("internal", "empty question");
      await textThread({ kind: "followUp", text });
    },

    async openThread(threadId) {
      const thread = await threadOf(threadId);
      current = thread.id;
      fresh = false;
    },

    async openExternal(url) {
      if (!isSafeExternalUrl(url)) {
        log.warn("app.externalRefused", { scheme: schemeOf(url) });
        throw new SnapsolveError("internal", "only http(s) links open");
      }
      await deps.openExternal(url);
    },

    async clearHistory() {
      if (!(await deps.confirmClearHistory())) return false;
      const result = await store.clearHistory();
      if (!result.ok) log.error("app.clearFailed", { error: result.error });
      current = null;
      fresh = false;
      known.clear();
      unstarted.clear();
      broadcast();
      return true;
    },
  };

  return {
    async onCapture(shot) {
      // 088: the window is shown as soon as the screen is grabbed; the PNG is made and saved after.
      panel.open();
      const shownMs = now() - shot.startedAt;
      const target = await currentThread();
      fresh = false;
      if (!target) return newThread(shot, shownMs);
      if (decideAppend(target, config.maxScreenshotsPerThread) === "newThread") return newThread(shot, shownMs, lastAnswerText(target));
      dropPermissionCard();
      const shown = known.get(target.id) ?? target;
      // The chat it lands in says "Thinking…" until the runner takes the turn (its status and turn events).
      remember(BUSY.has(shown.status) ? shown : { ...shown, status: "new" });
      broadcast();
      const saved = await saveShot(target.id, shot, shownMs, shown.status);
      if (!saved) return target.id;
      start(target.id, unstarted.delete(target.id) ? { kind: "new", screenshot: saved.file } : { kind: "append", screenshot: saved.file });
      return target.id;
    },

    async onCaptureDenied(prompted) {
      permissionId ??= randomUUID();
      remember(permissionCard(permissionId, "Screen Recording", "screenRecordingDenied", screenRecordingCard(prompted).message, { prompted }));
      panel.open();
      broadcast();
    },

    async onVoice(text) {
      if (typeof text !== "string" || text.trim() === "") throw new SnapsolveError("internal", "empty dictation");
      if (voiceCardId) known.delete(voiceCardId);
      voiceCardId = null;
      const request = { kind: "followUp" as const, text, voice: true as const };
      const target = await currentThread();
      if (!target) return textThread(request);
      fresh = false;
      if (!known.has(target.id)) remember(target);
      panel.open();
      broadcast();
      start(target.id, request);
      return target.id;
    },

    onVoiceDenied: (denial) => voiceCard(denial),
    onVoiceFailed: () => voiceCard("failed"),

    isAnswering() {
      if (fresh || !current) return false;
      const thread = known.get(current);
      return thread !== undefined && BUSY.has(thread.status);
    },

    handlers,
  };
}

/** Newest first: createdAt, then id (the panel's order). */
function byNewest(threads: Thread[]): Thread[] {
  return threads.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

const BUSY: ReadonlySet<Thread["status"]> = new Set(["new", "queued", "running"]);

/**
 * At startup, before the panel's first listing: a thread an earlier run left `new`, `queued` or `running` (quit or
 * crash mid-turn) becomes `error`, so its card offers Retry instead of "Thinking…" forever; one whose last turn is
 * already a successful answer becomes `done`. Unreadable threads are skipped (the store never rewrites them). Returns
 * the ids it changed; never throws.
 */
export async function recoverBusyThreads(deps: { store: Pick<Store, "listThreads" | "updateThread">; log: Logger }): Promise<string[]> {
  const { store, log } = deps;
  let threads: Thread[];
  try {
    threads = await store.listThreads();
  } catch (e) {
    log.warn("app.staleThreadsUnlisted", { error: e });
    return [];
  }
  const recovered: string[] = [];
  for (const thread of threads) {
    if (!BUSY.has(thread.status)) continue;
    const last = thread.turns.at(-1);
    const status = last?.role === "assistant" && !last.isError ? "done" : "error";
    try {
      await store.updateThread(thread.id, { status });
      recovered.push(thread.id);
      log.warn("app.staleThreadRecovered", { threadId: thread.id, was: thread.status, now: status });
    } catch (e) {
      log.warn("app.staleThreadNotRecovered", { threadId: thread.id, error: e });
    }
  }
  return recovered;
}

/**
 * SPEC §6.1: `claudePath` from config, else the first `claude` on PATH, else `~/.local/bin`. On Windows only
 * `claude.exe` counts (the app spawns without a shell, so npm's `claude.cmd` cannot run; DECISIONS 023). Nothing
 * found → plain `claude`, whose spawn fails with ENOENT and shows the "Claude Code not found" card.
 */
export function resolveClaudeCommand(options: {
  claudePath: string | null;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string;
  isFile: (file: string) => boolean;
}): Command {
  if (options.claudePath) return { path: options.claudePath, prefixArgs: [] };
  const win = options.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const name = win ? "claude.exe" : "claude";
  const pathKey = win ? Object.keys(options.env).find((k) => k.toUpperCase() === "PATH") : "PATH";
  const dirs = (pathKey ? (options.env[pathKey] ?? "") : "").split(win ? ";" : ":");
  for (const dir of [...dirs, p.join(options.home, ".local", "bin")]) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const file = p.join(dir, name);
    if (options.isFile(file)) return { path: file, prefixArgs: [] };
  }
  return { path: "claude", prefixArgs: [] };
}

/** An errored assistant turn that was never claude's: a permission card's text, or a capture that could not be saved. */
function errorTurn(errorKind: AssistantTurn["errorKind"], errorMessage: string): AssistantTurn {
  return { role: "assistant", text: "", durationMs: 0, ttftMs: null, costUsd: null, isError: true, errorKind, errorMessage };
}

function wholeMs(ms: number): number {
  return Math.round(ms);
}

/** The thread's last successful, non-empty answer: what a thread started past the screenshot limit is seeded with. */
function lastAnswerText(thread: Thread): string | undefined {
  return thread.turns.findLast((t): t is AssistantTurn => t.role === "assistant" && !t.isError && t.text.trim() !== "")?.text;
}

function schemeOf(url: unknown): string {
  try {
    return typeof url === "string" ? new URL(url).protocol : typeof url;
  } catch {
    return "invalid";
  }
}


/**
 * Tray Appearance (077, SPEC Amendment 14): the theme applies at once through Electron's `nativeTheme.themeSource`
 * (the open window restyles via prefers-color-scheme), `config.theme` follows for any later window, then the choice
 * is saved. A failed save is logged; the theme still holds for this run.
 */
export async function applyTheme(
  theme: Theme,
  deps: {
    nativeTheme: { themeSource: Theme };
    config: Pick<Config, "theme">;
    save: (theme: Theme) => Promise<{ ok: true } | { ok: false; error: string }>;
    log: Pick<Logger, "warn">;
  },
): Promise<void> {
  deps.nativeTheme.themeSource = theme;
  deps.config.theme = theme;
  try {
    const result = await deps.save(theme);
    if (!result.ok) deps.log.warn("theme.saveFailed", { theme, error: result.error });
  } catch (e) {
    deps.log.warn("theme.saveFailed", { theme, error: e });
  }
}
