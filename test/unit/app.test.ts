import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, resolveClaudeCommand, type AppDeps } from "../../src/main/app";
import type { Logger } from "../../src/main/log";
import type { RunnerEvent, TurnRequest } from "../../src/main/runner";
import { createStore, type Store } from "../../src/main/store";
import { CONTINUED_NOTE, continuedNote } from "../../src/shared/errors";
import { IPC } from "../../src/shared/ipc";
import type { AssistantTurn, Thread } from "../../src/shared/types";

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

let root: string;
let store: Store;
let calls: string[];
let listener: ((e: RunnerEvent) => void) | null;
let deps: AppDeps & {
  runner: { enqueue: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  panel: { open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snapsolve-app-"));
  store = createStore({ dataDir: path.join(root, "data"), projectsDir: path.join(root, "projects"), purge: async () => {}, log: quietLog });
  calls = [];
  listener = null;
  deps = {
    store,
    runner: {
      enqueue: vi.fn(async (threadId: string, request: TurnRequest) => {
        calls.push(`enqueue:${request.kind}`);
        return { ok: true as const, thread: await store.getThread(threadId) };
      }),
      on: vi.fn((l: (e: RunnerEvent) => void) => {
        listener = l;
        return () => undefined;
      }),
    },
    panel: {
      open: vi.fn(() => calls.push("open")),
      send: vi.fn((channel: string) => calls.push(channel)),
    },
    config: { model: "opus", effort: "high", maxScreenshotsPerThread: 6 },
    log: quietLog,
    clipboard: { writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    confirmClearHistory: vi.fn(async () => true),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const sent = (channel: string) => deps.panel.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);

async function erroredThread(turns: Thread["turns"]): Promise<Thread> {
  const t = await store.createThread({ model: "opus", effort: "high" });
  for (const turn of turns) await store.appendTurn(t.id, turn);
  return store.updateThread(t.id, { status: "error" });
}

const errorTurn: AssistantTurn = {
  role: "assistant",
  text: "",
  durationMs: 5,
  ttftMs: null,
  costUsd: null,
  isError: true,
  errorKind: "timeout",
  errorMessage: "Timed out and stopped. Press Retry to try again.",
};

const answer = (text: string): AssistantTurn => ({ role: "assistant", text, durationMs: 5, ttftMs: 1, costUsd: null, isError: false });

describe("onCapture", () => {
  it("creates a thread with the configured model, saves the PNG, opens the panel with the card, then enqueues the turn", async () => {
    const app = createApp(deps);
    let savedAtOpen = false;
    deps.panel.open.mockImplementation(() => {
      calls.push("open");
      const threads = path.join(root, "data", "threads");
      savedAtOpen = readdirSync(threads).some((id) => existsSync(path.join(threads, id, "001.png")));
    });
    const id = await app.onCapture({ png: PNG });

    const thread = await store.getThread(id);
    expect(thread).toMatchObject({ model: "opus", effort: "high" });
    expect(await readFile(store.screenshotPath(id, 1))).toEqual(Buffer.from(PNG));
    expect(savedAtOpen).toBe(true);
    expect(calls).toEqual(["open", IPC.threadsChanged, "enqueue:new"]);
    expect((sent(IPC.threadsChanged)[0] as Thread[]).map((t) => t.id)).toContain(id);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "new", screenshot: "001.png" });
  });

  it("does not wait for the turn to finish", async () => {
    deps.runner.enqueue.mockImplementation(() => new Promise(() => undefined));
    const app = createApp(deps);
    await expect(app.onCapture({ png: PNG })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("onAppend", () => {
  it("adds the screenshot to the most recent capture's thread", async () => {
    const app = createApp(deps);
    const first = await app.onCapture({ png: PNG });
    const second = await app.onCapture({ png: PNG });
    const target = await app.onAppend({ png: PNG2 });
    expect(target).toBe(second);
    expect(target).not.toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(second, { kind: "append", screenshot: "002.png" });
    expect(await readFile(store.screenshotPath(second, 2))).toEqual(Buffer.from(PNG2));
  });

  it("with no capture yet starts a new thread", async () => {
    const app = createApp(deps);
    const id = await app.onAppend({ png: PNG });
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "new", screenshot: "001.png" });
  });

  it("at maxScreenshotsPerThread starts a new thread", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture({ png: PNG });
    await store.appendTurn(first, { role: "user", kind: "screenshot", file: "001.png" });
    const next = await app.onAppend({ png: PNG2 });
    expect(next).not.toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(next, { kind: "new", screenshot: "001.png" });
  });

  it("at the cap: the new thread's turn is seeded with the previous thread's last answer (051)", async () => {
    deps.config.maxScreenshotsPerThread = 2;
    const app = createApp(deps);
    const first = await app.onCapture({ png: PNG });
    for (const turn of [
      { role: "user", kind: "screenshot", file: "001.png" },
      answer("first answer"),
      { role: "user", kind: "screenshot", file: "002.png" },
      answer("x = 4, so y = 2."),
    ] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onAppend({ png: PNG2 });
    expect(next).not.toBe(first);
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png", seed: "x = 4, so y = 2." }]);
    expect(await readFile(store.screenshotPath(next, 1))).toEqual(Buffer.from(PNG2));
    // The new thread becomes the append target.
    await app.onAppend({ png: PNG });
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "append", screenshot: "002.png" }]);
  });

  it("at the cap, the seed is the last successful answer, skipping a later errored one", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture({ png: PNG });
    for (const turn of [
      { role: "user", kind: "screenshot", file: "001.png" },
      answer("x = 4"),
      { role: "user", kind: "text", text: "why?" },
      { ...errorTurn, text: "partial" },
    ] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onAppend({ png: PNG2 });
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png", seed: "x = 4" }]);
  });

  it("at the cap with no successful answer (only errors, or an empty answer): a plain new thread, no seed key", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture({ png: PNG });
    for (const turn of [{ role: "user", kind: "screenshot", file: "001.png" }, errorTurn, answer("")] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onAppend({ png: PNG2 });
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png" }]);
  });

  it("a capture (not an append) never seeds, even when the previous thread is full", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture({ png: PNG });
    for (const turn of [{ role: "user", kind: "screenshot", file: "001.png" }, answer("x = 4")] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onCapture({ png: PNG2 });
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png" }]);
  });
});

describe("continuedNote (051)", () => {
  it("is the card's text for a thread seeded from the previous one, and only for that", () => {
    expect(CONTINUED_NOTE).toMatch(/continued from the previous thread/i);
    const seeded = { role: "user", kind: "screenshot", file: "001.png", seed: "x = 4" } as const;
    const plain = { role: "user", kind: "screenshot", file: "001.png" } as const;
    expect(continuedNote(seeded)).toBe(CONTINUED_NOTE);
    expect(continuedNote(plain)).toBeNull();
    expect(continuedNote({ role: "user", kind: "text", text: "why?" })).toBeNull();
    expect(continuedNote(answer("x = 4"))).toBeNull();
  });
});

describe("runner events → panel", () => {
  it("delta → answer:delta, done → answer:done with the saved thread", async () => {
    createApp(deps);
    const thread = await store.createThread({ model: "opus", effort: "high" });
    listener!({ type: "delta", threadId: thread.id, text: "x = " });
    expect(deps.panel.send).toHaveBeenCalledWith(IPC.answerDelta, { threadId: thread.id, text: "x = " });
    const turn = { ...errorTurn, isError: false, text: "x = 4" };
    listener!({ type: "done", threadId: thread.id, thread, turn });
    expect(deps.panel.send).toHaveBeenCalledWith(IPC.answerDone, { threadId: thread.id, thread });
  });

  it("an error with a saved thread → answer:done; without one → threads:changed", async () => {
    createApp(deps);
    const thread = await erroredThread([]);
    listener!({ type: "error", threadId: thread.id, kind: "timeout", message: "m", retry: true, thread });
    expect(deps.panel.send).toHaveBeenCalledWith(IPC.answerDone, { threadId: thread.id, thread });
    listener!({ type: "error", threadId: thread.id, kind: "internal", message: "m", retry: true, thread: null });
    await vi.waitFor(() => expect(sent(IPC.threadsChanged).length).toBeGreaterThan(0));
  });

  it("status changes are broadcast as threads:changed", async () => {
    createApp(deps);
    const thread = await store.createThread({ model: "opus", effort: "high" });
    listener!({ type: "status", threadId: thread.id, status: "queued" });
    await vi.waitFor(() => expect(sent(IPC.threadsChanged).length).toBeGreaterThan(0));
  });
});

describe("IPC handlers", () => {
  it("listThreads returns every thread, newest first", async () => {
    const app = createApp(deps);
    const a = await app.onCapture({ png: PNG });
    const b = await app.onCapture({ png: PNG });
    const list = await app.handlers.listThreads();
    expect(list.map((t) => t.id).sort()).toEqual([a, b].sort());
  });

  it("followUp enqueues the text on that thread", async () => {
    const app = createApp(deps);
    const id = await app.onCapture({ png: PNG });
    await app.handlers.followUp(id, "why 4?");
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(id, { kind: "followUp", text: "why 4?" });
  });

  it("followUp rejects empty or non-string text and unknown or malformed ids, enqueuing nothing", async () => {
    const app = createApp(deps);
    const id = await app.onCapture({ png: PNG });
    deps.runner.enqueue.mockClear();
    await expect(app.handlers.followUp(id, "   ")).rejects.toThrow();
    await expect(app.handlers.followUp(id, 42 as unknown as string)).rejects.toThrow();
    await expect(app.handlers.followUp("../x", "hi")).rejects.toThrow();
    await expect(app.handlers.followUp("0b6c1f8e-7d4a-4c2b-9e3f-1a2b3c4d5e6f", "hi")).rejects.toThrow();
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });

  it("retry of an errored follow-up queues a retry request (the runner re-runs the turn without re-adding it)", async () => {
    const app = createApp(deps);
    const t = await erroredThread([
      { role: "user", kind: "screenshot", file: "001.png" },
      { ...errorTurn, isError: false, text: "x = 4", errorKind: undefined, errorMessage: undefined },
      { role: "user", kind: "text", text: "why?" },
      errorTurn,
    ]);
    await app.handlers.retry(t.id);
    expect(deps.runner.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(t.id, { kind: "retry" });
  });

  it("retry of a failed first screenshot, a failed append, or a turn that failed before claude ran queues a retry", async () => {
    const app = createApp(deps);
    const first = await erroredThread([{ role: "user", kind: "screenshot", file: "001.png" }, errorTurn]);
    await app.handlers.retry(first.id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(first.id, { kind: "retry" });
    const later = await erroredThread([
      { role: "user", kind: "screenshot", file: "001.png" },
      { ...errorTurn, isError: false, text: "x = 4", errorKind: undefined, errorMessage: undefined },
      { role: "user", kind: "screenshot", file: "002.png" },
      errorTurn,
    ]);
    await app.handlers.retry(later.id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(later.id, { kind: "retry" });
    // An exception before claude ran leaves the user turn without an errored answer.
    const bare = await erroredThread([{ role: "user", kind: "screenshot", file: "001.png" }]);
    await app.handlers.retry(bare.id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(bare.id, { kind: "retry" });
    expect(deps.runner.enqueue).toHaveBeenCalledTimes(3);
  });

  it("retry of an errored thread whose last turn is a successful answer, or that has no user turn, queues nothing", async () => {
    const app = createApp(deps);
    const answered = await erroredThread([
      { role: "user", kind: "screenshot", file: "001.png" },
      { ...errorTurn, isError: false, text: "x = 4", errorKind: undefined, errorMessage: undefined },
    ]);
    await app.handlers.retry(answered.id);
    const empty = await erroredThread([]);
    await app.handlers.retry(empty.id);
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });

  it("retry of a thread that is not errored does nothing", async () => {
    const app = createApp(deps);
    const id = await app.onCapture({ png: PNG });
    deps.runner.enqueue.mockClear();
    await app.handlers.retry(id);
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });

  it("copy writes the text to the clipboard; a non-string is refused", async () => {
    const app = createApp(deps);
    await app.handlers.copy("**x = 4**");
    expect(deps.clipboard.writeText).toHaveBeenCalledWith("**x = 4**");
    await expect(app.handlers.copy({} as unknown as string)).rejects.toThrow();
    expect(deps.clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  it("openExternal opens only http(s) URLs", async () => {
    const app = createApp(deps);
    await app.handlers.openExternal("https://example.com/");
    expect(deps.openExternal).toHaveBeenCalledWith("https://example.com/");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ms-settings:privacy", 7]) {
      await app.handlers.openExternal(url as string).catch(() => undefined);
    }
    expect(deps.openExternal).toHaveBeenCalledTimes(1);
  });

  it("clearHistory: cancelled confirm → false and nothing deleted; confirmed → threads gone, [] broadcast, true", async () => {
    const id = await createApp(deps).onCapture({ png: PNG });
    deps.confirmClearHistory = vi.fn(async () => false);
    expect(await createApp(deps).handlers.clearHistory()).toBe(false);
    expect((await store.listThreads()).map((t) => t.id)).toEqual([id]);

    deps.panel.send.mockClear();
    deps.confirmClearHistory = vi.fn(async () => true);
    expect(await createApp(deps).handlers.clearHistory()).toBe(true);
    expect(await store.listThreads()).toEqual([]);
    expect(sent(IPC.threadsChanged)).toContainEqual([]);
  });
});

describe("resolveClaudeCommand", () => {
  const files = (...paths: string[]) => {
    const set = new Set(paths);
    return (p: string) => set.has(p);
  };

  it("config claudePath wins", () => {
    expect(
      resolveClaudeCommand({ claudePath: "/opt/claude/bin/claude", env: { PATH: "/usr/bin" }, platform: "darwin", home: "/Users/e", isFile: files() }),
    ).toEqual({ path: "/opt/claude/bin/claude", prefixArgs: [] });
  });

  it("null → the first claude on PATH (macOS)", () => {
    const got = resolveClaudeCommand({
      claudePath: null,
      env: { PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin" },
      platform: "darwin",
      home: "/Users/e",
      isFile: files("/opt/homebrew/bin/claude", "/usr/local/bin/claude"),
    });
    expect(got).toEqual({ path: "/opt/homebrew/bin/claude", prefixArgs: [] });
  });

  it("Windows: only claude.exe counts, PATH is found case-insensitively (Path)", () => {
    const got = resolveClaudeCommand({
      claudePath: null,
      env: { Path: "C:\\npm;C:\\tools" },
      platform: "win32",
      home: "C:\\Users\\e",
      isFile: files("C:\\npm\\claude.cmd", "C:\\npm\\claude", "C:\\tools\\claude.exe"),
    });
    expect(got).toEqual({ path: "C:\\tools\\claude.exe", prefixArgs: [] });
  });

  it("then ~/.local/bin; relative PATH entries are skipped", () => {
    const got = resolveClaudeCommand({
      claudePath: null,
      env: { PATH: ".:bin:/usr/bin" },
      platform: "darwin",
      home: "/Users/e",
      isFile: files("bin/claude", "./claude", "/Users/e/.local/bin/claude"),
    });
    expect(got).toEqual({ path: "/Users/e/.local/bin/claude", prefixArgs: [] });
    expect(
      resolveClaudeCommand({ claudePath: null, env: {}, platform: "win32", home: "C:\\Users\\e", isFile: files("C:\\Users\\e\\.local\\bin\\claude.exe") }),
    ).toEqual({ path: "C:\\Users\\e\\.local\\bin\\claude.exe", prefixArgs: [] });
  });

  it("nothing found → plain `claude`, so the spawn fails with ENOENT (claudeNotFound card)", () => {
    expect(resolveClaudeCommand({ claudePath: null, env: { PATH: "/usr/bin" }, platform: "darwin", home: "/Users/e", isFile: files() })).toEqual({
      path: "claude",
      prefixArgs: [],
    });
  });
});
