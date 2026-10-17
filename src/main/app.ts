// The capture → store → runner → panel pipeline (SPEC §2.1, §3.5, §4.2): a capture becomes a new thread whose
// screenshot is saved and whose card is on screen before claude is spawned; an append joins the most recent
// capture's thread; runner events and the renderer's requests (SPEC §4.4) are relayed between runner and panel.
import path from "node:path";
import { SnapsolveError } from "../shared/errors";
import { IPC, type IpcEvents } from "../shared/ipc";
import type { Config, Thread } from "../shared/types";
import { formatUsage } from "./auth";
import { decideAppend } from "./capture";
import type { Logger } from "./log";
import { isSafeExternalUrl } from "./panel";
import type { Command, Runner, RunnerEvent, TurnOutcome, TurnRequest } from "./runner";
import { isUuid, type Store } from "./store";

export interface AppDeps {
  store: Store;
  runner: Pick<Runner, "enqueue" | "on">;
  panel: { open(): void; send<C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]): void };
  config: Pick<Config, "model" | "effort" | "maxScreenshotsPerThread">;
  log: Logger;
  clipboard: { writeText(text: string): void };
  /** `shell.openExternal`; only ever called with an http(s) URL. */
  openExternal: (url: string) => Promise<void>;
  /** The native confirm dialog before clearing history; true = go ahead. */
  confirmClearHistory: () => Promise<boolean>;
  /** Called after every turn ends (the panel's auto-hide countdown). */
  onTurnEnded?: () => void;
  /** The usage line ("5h N% · 7d M%") from every `rate_limit_event`: the tray tooltip (SPEC §3.6). */
  onUsage?: (usage: string) => void;
}

/** A capture's full-resolution PNG (`Screenshot` from capture.ts, or a test fixture). */
export interface Shot {
  png: Uint8Array;
}

export type AppHandlers = {
  listThreads(): Promise<Thread[]>;
  followUp(threadId: string, text: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  clearHistory(): Promise<boolean>;
};

export interface App {
  /** SPEC §3.5: always a new thread. Resolves with its id once the card is shown and the turn is queued. */
  onCapture(shot: Shot): Promise<string>;
  /** Joins the most recent capture's thread; a new thread when there is none or it is full (SPEC §2.3). */
  onAppend(shot: Shot): Promise<string>;
  /** The renderer's requests (arguments come from the renderer, so each is checked). */
  handlers: AppHandlers;
}

export function createApp(deps: AppDeps): App {
  const { store, runner, panel, config, log } = deps;
  let current: string | null = null;
  // The threads as the renderer should see them: disk at first listing, then every change in event order. Re-reading
  // disk after an event could deliver a snapshot older than an answer:done already sent.
  const known = new Map<string, Thread>();

  function remember(thread: Thread): void {
    known.set(thread.id, thread);
  }

  function broadcast(): void {
    panel.send(IPC.threadsChanged, snapshot());
  }

  function snapshot(): Thread[] {
    return [...known.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
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

  async function newThread(shot: Shot): Promise<string> {
    const thread = await store.createThread({ model: config.model, effort: config.effort });
    // SPEC §2.1: the full-resolution PNG is on disk before anything is sent.
    const saved = await store.saveScreenshot(thread.id, shot.png);
    current = thread.id;
    remember(thread);
    // SPEC §4.2: the card (thumbnail + "Thinking…") is on screen before claude is spawned.
    panel.open();
    broadcast();
    start(thread.id, { kind: "new", screenshot: saved.file });
    return thread.id;
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
      const request = retryRequest(thread);
      if (!request) {
        log.warn("app.retryNothing", { threadId: thread.id });
        return;
      }
      start(thread.id, request);
    },

    async copy(text) {
      if (typeof text !== "string") throw new SnapsolveError("internal", "copy needs text");
      deps.clipboard.writeText(text);
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
      known.clear();
      broadcast();
      return true;
    },
  };

  return {
    onCapture: newThread,

    async onAppend(shot) {
      let target: Thread | null = null;
      if (current) target = await store.getThread(current).catch(() => null);
      if (!target || decideAppend(target, config.maxScreenshotsPerThread) === "newThread") return newThread(shot);
      const saved = await store.saveScreenshot(target.id, shot.png);
      if (!known.has(target.id)) remember(target);
      panel.open();
      broadcast();
      start(target.id, { kind: "append", screenshot: saved.file });
      return target.id;
    },

    handlers,
  };
}

/** The request that re-runs an errored thread's last user turn. */
function retryRequest(thread: Thread): TurnRequest | null {
  const users = thread.turns.filter((t) => t.role === "user");
  const last = users.at(-1);
  if (!last) return null;
  if (last.kind === "text") return { kind: "followUp", text: last.text };
  return { kind: users.length === 1 ? "new" : "append", screenshot: last.file };
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

function schemeOf(url: unknown): string {
  try {
    return typeof url === "string" ? new URL(url).protocol : typeof url;
  } catch {
    return "invalid";
  }
}

