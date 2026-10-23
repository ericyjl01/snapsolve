import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, applyTransparency, createApp, recoverBusyThreads, resolveClaudeCommand, type AppDeps, type Shot } from "../../src/main/app";
import { createCapturer, ScreenRecordingDeniedError, type CapturerDeps } from "../../src/main/capture";
import type { ImageLike } from "../../src/main/encode";
import type { Logger } from "../../src/main/log";
import type { RunnerEvent, TurnRequest } from "../../src/main/runner";
import { createStore, type Store } from "../../src/main/store";
import { CONTINUED_NOTE, continuedNote, userMessage } from "../../src/shared/errors";
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
    openExternal: vi.fn(async () => undefined),
    confirmClearHistory: vi.fn(async () => true),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const sent = (channel: string) => deps.panel.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);

/** A capture as the capturer hands it over (088): its PNG is made only when the pipeline calls `encode`. */
function shot(png: Uint8Array, timing: { startedAt?: number; grabMs?: number; pngMs?: number; encodeMs?: number } = {}): Shot {
  return {
    startedAt: timing.startedAt ?? 0,
    grabMs: timing.grabMs ?? 0,
    encode: () => ({ png, pngMs: timing.pngMs ?? 0, encodeMs: timing.encodeMs ?? 0 }),
  };
}

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
  it("creates a thread with the configured model, opens the panel with the card, saves the PNG, then enqueues the turn", async () => {
    const app = createApp(deps);
    const threads = path.join(root, "data", "threads");
    const savedNow = () => existsSync(threads) && readdirSync(threads).some((id) => existsSync(path.join(threads, id, "001.png")));
    let savedAtOpen: boolean | undefined;
    let savedAtEnqueue: boolean | undefined;
    deps.panel.open.mockImplementation(() => {
      calls.push("open");
      savedAtOpen = savedNow();
    });
    const enqueue = deps.runner.enqueue.getMockImplementation();
    deps.runner.enqueue.mockImplementation(async (threadId: string, request: TurnRequest) => {
      savedAtEnqueue = savedNow();
      return enqueue?.(threadId, request);
    });
    const id = await app.onCapture(shot(PNG));

    const thread = await store.getThread(id);
    expect(thread).toMatchObject({ model: "opus", effort: "high" });
    expect(await readFile(store.screenshotPath(id, 1))).toEqual(Buffer.from(PNG));
    // 088: the window is shown first; SPEC §2.1: the PNG is still on disk before anything is sent.
    expect(savedAtOpen).toBe(false);
    expect(savedAtEnqueue).toBe(true);
    expect(calls).toEqual(["open", IPC.threadsChanged, "enqueue:new"]);
    expect((sent(IPC.threadsChanged)[0] as Thread[]).map((t) => t.id)).toContain(id);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "new", screenshot: "001.png" });
  });

  it("does not wait for the turn to finish", async () => {
    deps.runner.enqueue.mockImplementation(() => new Promise(() => undefined));
    const app = createApp(deps);
    await expect(app.onCapture(shot(PNG))).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

// 088: a capture while the window is hidden shows it as soon as the screen is grabbed; the PNG, the model's image and
// the save come after, with "Thinking…" in the chat the capture lands in.
describe("onCapture shows the window before the PNG is made and saved (088)", () => {
  class Thumb implements ImageLike {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getSize() {
      return { width: this.width, height: this.height };
    }
    resize(options: { width: number; height: number }): ImageLike {
      calls.push(`resize ${options.width}x${options.height}`);
      return new Thumb(options.width, options.height);
    }
    toPNG(): Buffer {
      calls.push(`toPNG ${this.width}x${this.height}`);
      return Buffer.from(PNG);
    }
    toJPEG(): Buffer {
      calls.push("toJPEG");
      return Buffer.from("jpeg");
    }
  }

  /** macOS with Screen Recording granted and the window hidden (Eric's 3440 × 1440 display), as main.ts wires it. */
  function capturerDeps(overrides: Partial<CapturerDeps> = {}): CapturerDeps {
    const display = { id: 1, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, size: { width: 3440, height: 1440 }, scaleFactor: 1 };
    return {
      desktopCapturer: {
        getSources: async () => {
          calls.push("grab");
          return [{ display_id: "1", thumbnail: new Thumb(3440, 1440) }];
        },
      },
      screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => display },
      panel: { isOpen: () => false, hide: () => calls.push("hide"), show: () => calls.push("show") },
      mediaAccess: { getMediaAccessStatus: () => "granted" },
      platform: "darwin",
      osRelease: "25.6.0",
      wait: async () => undefined,
      ...overrides,
    };
  }

  /** Records `save` in `calls` (before createApp); `fail(n)` makes the n-th save reject, `onSave` runs before each. */
  function recordSaves(options: { fail?: (n: number) => boolean; onSave?: () => void } = {}): void {
    const save = store.saveScreenshot;
    let n = 0;
    deps.store = {
      ...store,
      saveScreenshot: async (id, png) => {
        calls.push("save");
        options.onSave?.();
        if (options.fail?.(++n)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return save(id, png);
      },
    };
  }

  /** A chat on disk with one screenshot and its answer, done: the current thread a capture appends to. */
  async function answeredThread(): Promise<string> {
    const t = await store.createThread({ model: "opus", effort: "high" });
    await store.saveScreenshot(t.id, PNG);
    await store.appendTurn(t.id, { role: "user", kind: "screenshot", file: "001.png" });
    await store.appendTurn(t.id, answer("x = 4"));
    await store.updateThread(t.id, { status: "done" });
    return t.id;
  }

  const latest = (id: string) => (sent(IPC.threadsChanged).at(-1) as Thread[]).find((t) => t.id === id) as Thread;
  const BUSY = ["new", "queued", "running"];

  it("hidden window: grab, then panel.open, then the PNG, the model's image and the save, then the turn; the id returned is the thread shown", async () => {
    recordSaves();
    const app = createApp(deps);
    let shownAtOpen: Thread[] | undefined;
    deps.panel.send.mockImplementation((channel: string, payload: unknown) => {
      calls.push(channel);
      if (channel === IPC.threadsChanged && shownAtOpen === undefined) shownAtOpen = payload as Thread[];
    });
    const id = await createCapturer(capturerDeps()).capture().then(app.onCapture);

    expect(calls).toEqual(["grab", "open", IPC.threadsChanged, "toPNG 3440x1440", "resize 2576x1078", "toPNG 2576x1078", "save", "enqueue:new"]);
    // The card the window shows first is this capture's thread, "Thinking…" (busy, nothing saved yet).
    const first = shownAtOpen?.find((t) => t.id === id);
    expect(first).toBeDefined();
    expect(BUSY).toContain(first?.status);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "new", screenshot: "001.png" });
  });

  it("an append: the current chat shows Thinking… from the moment the window opens, before its PNG is saved", async () => {
    const id = await answeredThread();
    let statusAtSave: string | undefined;
    recordSaves({ onSave: () => (statusAtSave = latest(id).status) });
    const app = createApp(deps);
    expect(await app.onCapture(shot(PNG2))).toBe(id);
    expect(calls).toEqual(["open", IPC.threadsChanged, "save", "enqueue:append"]);
    expect(BUSY).toContain(statusAtSave);
    expect(latest(id).turns).toHaveLength(2);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "append", screenshot: "002.png" });
  });

  it("Screen Recording denied → the capture never reaches onCapture: no early open, only the permission card opens the window", async () => {
    const app = createApp(deps);
    const capturer = createCapturer(capturerDeps({ mediaAccess: { getMediaAccessStatus: () => "denied" } }));
    const error = await capturer
      .capture()
      .then(app.onCapture)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScreenRecordingDeniedError);
    expect(deps.panel.open).not.toHaveBeenCalled();
    await app.onCaptureDenied((error as ScreenRecordingDeniedError).prompted);
    expect(deps.panel.open).toHaveBeenCalledTimes(1);
    expect(await store.listThreads()).toEqual([]);
  });

  it("the grab throws → captureFailed as today: the window is not opened and nothing is created", async () => {
    const app = createApp(deps);
    const capturer = createCapturer(
      capturerDeps({
        desktopCapturer: {
          getSources: async () => {
            throw new Error("screen capture failed");
          },
        },
      }),
    );
    await expect(capturer.capture().then(app.onCapture)).rejects.toMatchObject({ kind: "captureFailed" });
    expect(deps.panel.open).not.toHaveBeenCalled();
    expect(await store.listThreads()).toEqual([]);
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });

  it("the save throws after the early open (a new chat) → the card shows the capture error, nothing is left Thinking…, nothing is queued", async () => {
    const warn = vi.fn();
    deps.log = { ...quietLog, warn };
    recordSaves({ fail: () => true });
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));

    expect(deps.panel.open).toHaveBeenCalledTimes(1);
    const card = latest(id);
    expect(BUSY).not.toContain(card.status);
    expect(card.turns.at(-1)).toMatchObject({ role: "assistant", isError: true, errorKind: "captureFailed", errorMessage: userMessage("captureFailed") });
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => (c[1] as { threadId?: string } | undefined)?.threadId === id)).toBe(true);
    expect(app.isAnswering()).toBe(false);
    // A restart does not find it busy (it would come back as an error card with nothing to retry).
    expect(BUSY).not.toContain((await store.getThread(id)).status);
  });

  it("the save throws on an append → the chat keeps its answer, shows the capture error, and is not left Thinking…", async () => {
    const id = await answeredThread();
    recordSaves({ fail: () => true });
    const app = createApp(deps);
    expect(await app.onCapture(shot(PNG2))).toBe(id);

    const card = latest(id);
    expect(card.status).toBe("done");
    expect(card.turns.at(-2)).toMatchObject({ role: "assistant", text: "x = 4", isError: false });
    expect(card.turns.at(-1)).toMatchObject({ isError: true, errorKind: "captureFailed" });
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
    expect(app.isAnswering()).toBe(false);
    // The error is the panel's alone: thread.json is unchanged.
    expect((await store.getThread(id)).turns).toHaveLength(2);
  });

  it("the next capture after a failed save continues that chat as its first turn", async () => {
    recordSaves({ fail: (n) => n === 1 });
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
    expect(await app.onCapture(shot(PNG2))).toBe(id);
    expect(deps.runner.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "new", screenshot: "001.png" });
    expect(await readFile(store.screenshotPath(id, 1))).toEqual(Buffer.from(PNG2));
  });

  it("logs one capture.timing line per capture: grabMs, pngMs, encodeMs, saveMs, shownMs (whole ms ≥ 0, nothing else)", async () => {
    const info = vi.fn();
    let clock = 1250;
    deps.log = { ...quietLog, info };
    deps.now = () => clock;
    const save = store.saveScreenshot;
    deps.store = {
      ...store,
      saveScreenshot: async (id, png) => {
        clock += 15;
        return save(id, png);
      },
    };
    const app = createApp(deps);
    await app.onCapture(shot(PNG, { startedAt: 1000, grabMs: 120.4, pngMs: 35.6, encodeMs: 80.2 }));
    await app.onCapture(shot(PNG2, { startedAt: 1200 }));

    const lines = info.mock.calls.filter((c) => c[0] === "capture.timing").map((c) => c[1] as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStrictEqual({ grabMs: 120, pngMs: 36, encodeMs: 80, saveMs: 15, shownMs: 250 });
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(["encodeMs", "grabMs", "pngMs", "saveMs", "shownMs"]);
      for (const v of Object.values(line)) expect(Number.isInteger(v) && (v as number) >= 0).toBe(true);
    }
  });
});

// 065: a capture continues the current thread (the newest one) until "+" (newThread) or the screenshot limit.
describe("onCapture continues the current thread (065)", () => {
  it("capture with a current thread appends: the second screenshot joins the same thread as an append turn", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    const second = await app.onCapture(shot(PNG2));
    expect(second).toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(first, { kind: "append", screenshot: "002.png" });
    expect(await readFile(store.screenshotPath(first, 2))).toEqual(Buffer.from(PNG2));
    expect(deps.panel.open).toHaveBeenCalledTimes(2);
  });

  it("capture with no thread starts one", async () => {
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "new", screenshot: "001.png" });
    expect(app).not.toHaveProperty("onAppend");
  });

  it("new chat makes the next capture start a new thread, and only the next one", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    // Nothing is created or queued by the click itself.
    expect(deps.runner.enqueue).toHaveBeenCalledTimes(1);
    expect((await store.listThreads()).length).toBe(1);
    const second = await app.onCapture(shot(PNG2));
    expect(second).not.toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(second, { kind: "new", screenshot: "001.png" });
    const third = await app.onCapture(shot(PNG));
    expect(third).toBe(second);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(second, { kind: "append", screenshot: "002.png" });
  });

  it("new chat twice in a row is still one new thread at the next capture", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    await app.handlers.newThread();
    const second = await app.onCapture(shot(PNG2));
    expect(second).not.toBe(first);
    expect(await app.onCapture(shot(PNG))).toBe(second);
  });

  it("new chat then a typed question starts a new text thread, which the next capture continues", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    await app.handlers.newThread("What is 2 + 2?");
    const threads = await store.listThreads();
    expect(threads).toHaveLength(2);
    const text = threads.find((t) => t.id !== first) as Thread;
    expect(text).toMatchObject({ model: "opus", effort: "high" });
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(text.id, { kind: "followUp", text: "What is 2 + 2?" });
    expect((sent(IPC.threadsChanged).at(-1) as Thread[]).map((t) => t.id)).toContain(text.id);
    expect(deps.panel.open).toHaveBeenCalled();
    // The text thread is now the current one: no "new chat" left over.
    expect(await app.onCapture(shot(PNG2))).toBe(text.id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(text.id, { kind: "append", screenshot: "001.png" });
  });

  it("a typed question with no thread at all starts a text thread", async () => {
    const app = createApp(deps);
    await app.handlers.newThread("hello");
    const [thread] = await store.listThreads();
    expect(deps.runner.enqueue).toHaveBeenCalledWith(thread.id, { kind: "followUp", text: "hello" });
  });

  it.each([["   "], [""], [42], [{}]])("newThread(%j) is refused and changes nothing", async (text) => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await expect(app.handlers.newThread(text as unknown as string)).rejects.toThrow();
    expect((await store.listThreads()).length).toBe(1);
    expect(deps.runner.enqueue).toHaveBeenCalledTimes(1);
    // A refused question does not mark "new chat" either.
    expect(await app.onCapture(shot(PNG2))).toBe(first);
  });

  it("current thread after restart is the newest on disk", async () => {
    const older = await store.createThread({ model: "opus", effort: "high" });
    await new Promise((r) => setTimeout(r, 5));
    const newest = await store.createThread({ model: "opus", effort: "high" });
    await store.saveScreenshot(newest.id, PNG);
    await store.appendTurn(newest.id, { role: "user", kind: "screenshot", file: "001.png" });
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG2));
    expect(id).toBe(newest.id);
    expect(id).not.toBe(older.id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(newest.id, { kind: "append", screenshot: "002.png" });
  });

  it("after Clear history the next capture starts a new thread", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.clearHistory();
    const next = await app.onCapture(shot(PNG2));
    expect(next).not.toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(next, { kind: "new", screenshot: "001.png" });
  });

  it("7th screenshot still rolls over: at maxScreenshotsPerThread the capture starts a new thread", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await store.appendTurn(first, { role: "user", kind: "screenshot", file: "001.png" });
    const next = await app.onCapture(shot(PNG2));
    expect(next).not.toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(next, { kind: "new", screenshot: "001.png" });
  });

  it("at the cap: the new thread's turn is seeded with the previous thread's last answer (051), and it becomes current", async () => {
    deps.config.maxScreenshotsPerThread = 2;
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    for (const turn of [
      { role: "user", kind: "screenshot", file: "001.png" },
      answer("first answer"),
      { role: "user", kind: "screenshot", file: "002.png" },
      answer("x = 4, so y = 2."),
    ] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onCapture(shot(PNG2));
    expect(next).not.toBe(first);
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png", seed: "x = 4, so y = 2." }]);
    expect(await readFile(store.screenshotPath(next, 1))).toEqual(Buffer.from(PNG2));
    await app.onCapture(shot(PNG));
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "append", screenshot: "002.png" }]);
  });

  it("at the cap, the seed is the last successful answer, skipping a later errored one", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    for (const turn of [
      { role: "user", kind: "screenshot", file: "001.png" },
      answer("x = 4"),
      { role: "user", kind: "text", text: "why?" },
      { ...errorTurn, text: "partial" },
    ] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onCapture(shot(PNG2));
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png", seed: "x = 4" }]);
  });

  it("at the cap with no successful answer (only errors, or an empty answer): a plain new thread, no seed key", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    for (const turn of [{ role: "user", kind: "screenshot", file: "001.png" }, errorTurn, answer("")] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    const next = await app.onCapture(shot(PNG2));
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png" }]);
  });

  it("new chat never seeds: a full current thread then + then a capture is a plain new thread", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    for (const turn of [{ role: "user", kind: "screenshot", file: "001.png" }, answer("x = 4")] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    await app.handlers.newThread();
    const next = await app.onCapture(shot(PNG2));
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([next, { kind: "new", screenshot: "001.png" }]);
  });
});

// 063: a dictated question goes where a typed one would: the current thread, else a new text thread.
describe("onVoice (063)", () => {
  const SAID = "why the product rule?";

  it("transcript goes to the newest thread via the follow-up path, marked as dictated", async () => {
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
    deps.panel.open.mockClear();
    expect(await app.onVoice(SAID)).toBe(id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(id, { kind: "followUp", text: SAID, voice: true });
    expect(deps.panel.open).toHaveBeenCalled();
  });

  it("after a restart the newest thread on disk takes it", async () => {
    const older = await store.createThread({ model: "opus", effort: "high" });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await store.createThread({ model: "opus", effort: "high" });
    const app = createApp(deps);
    expect(await app.onVoice(SAID)).toBe(newer.id);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(newer.id, { kind: "followUp", text: SAID, voice: true });
    expect(older.id).not.toBe(newer.id);
  });

  it("no thread → a new text thread with the dictated question as its first turn", async () => {
    const app = createApp(deps);
    const id = await app.onVoice(SAID);
    expect(await store.listThreads()).toHaveLength(1);
    expect(deps.runner.enqueue).toHaveBeenCalledWith(id, { kind: "followUp", text: SAID, voice: true });
    expect((sent(IPC.threadsChanged).at(-1) as Thread[]).map((t) => t.id)).toEqual([id]);
  });

  it("after + a dictated question starts a new text thread; the next capture then continues that one", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    const second = await app.onVoice(SAID);
    expect(second).not.toBe(first);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(second, { kind: "followUp", text: SAID, voice: true });
    expect(await app.onCapture(shot(PNG2))).toBe(second);
  });

  it.each(["", "   ", 7 as unknown as string])("an empty transcript %j queues nothing", async (text) => {
    const app = createApp(deps);
    await expect(app.onVoice(text)).rejects.toThrow();
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });
});

describe("isAnswering (063): a voice press is ignored while the current thread thinks or answers", () => {
  it("no thread → false; a capture's thread is busy until its answer is done; after + → false", async () => {
    const app = createApp(deps);
    expect(app.isAnswering()).toBe(false);
    const id = await app.onCapture(shot(PNG));
    expect(app.isAnswering()).toBe(true);
    listener?.({ type: "status", threadId: id, status: "running" });
    await new Promise((r) => setTimeout(r, 10));
    expect(app.isAnswering()).toBe(true);
    const done = await store.updateThread(id, { status: "done" });
    listener?.({ type: "done", threadId: id, thread: done } as RunnerEvent);
    expect(app.isAnswering()).toBe(false);
    // An errored turn is not answering either.
    const errored = await store.updateThread(id, { status: "error" });
    listener?.({ type: "error", threadId: id, thread: errored } as RunnerEvent);
    expect(app.isAnswering()).toBe(false);
    // "+": the next question starts a new thread, so nothing is in the way.
    listener?.({ type: "status", threadId: id, status: "running" });
    await new Promise((r) => setTimeout(r, 10));
    expect(app.isAnswering()).toBe(true);
    await app.handlers.newThread();
    expect(app.isAnswering()).toBe(false);
  });

  it("a follow-up queued on the current thread makes it busy again", async () => {
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
    const done = await store.updateThread(id, { status: "done" });
    listener?.({ type: "done", threadId: id, thread: done } as RunnerEvent);
    listener?.({ type: "status", threadId: id, status: "queued" });
    await new Promise((r) => setTimeout(r, 10));
    expect(app.isAnswering()).toBe(true);
  });
});

describe("onVoiceDenied (063): mic denied shows a permission card", () => {
  it("opens the panel on one unsaved card naming what to turn on; a second denial replaces it; a dictation that works removes it", async () => {
    const app = createApp(deps);
    await app.onVoiceDenied("microphone");
    expect(deps.panel.open).toHaveBeenCalledTimes(1);
    let cards = sent(IPC.threadsChanged).at(-1) as Thread[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ permission: { voice: "microphone" }, status: "error" });
    expect(cards[0].turns[0]).toMatchObject({ role: "assistant", isError: true, errorKind: "microphoneDenied" });
    expect(await store.listThreads()).toEqual([]);

    await app.onVoiceDenied("speechRecognition");
    cards = sent(IPC.threadsChanged).at(-1) as Thread[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ permission: { voice: "speechRecognition" } });
    expect(cards[0].turns[0]).toMatchObject({ errorKind: "speechDenied" });

    const id = await app.onVoice("why the product rule?");
    cards = sent(IPC.threadsChanged).at(-1) as Thread[];
    expect(cards.map((t) => t.id)).toEqual([id]);
  });

  it("a helper failure shows one unsaved voice error card (no buttons' permission), in the same slot as a denial; a dictation that works removes it", async () => {
    const app = createApp(deps);
    await app.onVoiceDenied("microphone");
    await app.onVoiceFailed();
    let cards = sent(IPC.threadsChanged).at(-1) as Thread[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ permission: { voice: "failed" }, status: "error" });
    expect(cards[0].turns[0]).toMatchObject({ isError: true, errorKind: "voiceFailed" });
    expect(deps.panel.open).toHaveBeenCalledTimes(2);
    expect(await store.listThreads()).toEqual([]);
    const id = await app.onVoice("why the product rule?");
    cards = sent(IPC.threadsChanged).at(-1) as Thread[];
    expect(cards.map((t) => t.id)).toEqual([id]);
  });

  it("the voice card and the Screen Recording card are separate cards", async () => {
    const app = createApp(deps);
    await app.onCaptureDenied(false);
    await app.onVoiceDenied("microphone");
    const cards = sent(IPC.threadsChanged).at(-1) as Thread[];
    expect(cards).toHaveLength(2);
    expect(cards.map((t) => t.permission).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { prompted: false },
      { voice: "microphone" },
    ]);
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

  it("a turn event is broadcast as threads:changed with its saved user turn, so the continued note shows before the answer (057)", async () => {
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
    const before = sent(IPC.threadsChanged).length;
    const created = await store.getThread(id);
    const thread: Thread = {
      ...created,
      status: "running",
      turns: [{ role: "user", kind: "screenshot", file: "001.png", seed: "the previous answer" }],
    };
    listener!({ type: "turn", threadId: id, thread } as unknown as RunnerEvent);
    await vi.waitFor(() => expect(sent(IPC.threadsChanged).length).toBeGreaterThan(before));
    const shown = (sent(IPC.threadsChanged).at(-1) as Thread[]).find((t) => t.id === id);
    expect(shown?.turns).toEqual(thread.turns);
    expect(continuedNote(shown!.turns[0])).toBe(CONTINUED_NOTE);
    // A later status change keeps the turn.
    listener!({ type: "status", threadId: id, status: "running" });
    await vi.waitFor(() => expect(sent(IPC.threadsChanged).length).toBeGreaterThan(before + 1));
    expect((sent(IPC.threadsChanged).at(-1) as Thread[]).find((t) => t.id === id)?.turns).toEqual(thread.turns);
  });
});

describe("IPC handlers", () => {
  it("listThreads returns every thread, newest first", async () => {
    const app = createApp(deps);
    const a = await app.onCapture(shot(PNG));
    // A second capture would join the first thread (065): "+" first.
    await app.handlers.newThread();
    const b = await app.onCapture(shot(PNG));
    const list = await app.handlers.listThreads();
    expect(list.map((t) => t.id).sort()).toEqual([a, b].sort());
  });

  it("followUp enqueues the text on that thread", async () => {
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
    await app.handlers.followUp(id, "why 4?");
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(id, { kind: "followUp", text: "why 4?" });
  });

  it("followUp rejects empty or non-string text and unknown or malformed ids, enqueuing nothing", async () => {
    const app = createApp(deps);
    const id = await app.onCapture(shot(PNG));
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
    const id = await app.onCapture(shot(PNG));
    deps.runner.enqueue.mockClear();
    await app.handlers.retry(id);
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });

  // The Copy button and `copy` handler are gone with the restyle (061): nothing writes to the clipboard.
  it("exposes exactly the seven renderer handlers, none of them copy (061), newThread added (065), openThread added (078)", () => {
    const app = createApp(deps);
    expect(Object.keys(app.handlers).sort()).toEqual(
      ["listThreads", "followUp", "retry", "openExternal", "clearHistory", "newThread", "openThread"].sort(),
    );
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
    const id = await createApp(deps).onCapture(shot(PNG));
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

describe("recoverBusyThreads (052): threads left busy by an earlier run", () => {
  async function threadWith(status: Thread["status"], turns: Thread["turns"]): Promise<Thread> {
    const t = await store.createThread({ model: "opus", effort: "high" });
    await store.saveScreenshot(t.id, PNG);
    for (const turn of turns) await store.appendTurn(t.id, turn);
    return store.updateThread(t.id, { status });
  }
  const asked: Thread["turns"] = [{ role: "user", kind: "screenshot", file: "001.png" }];
  const logged = () => {
    const warn = vi.fn();
    return { log: { ...quietLog, warn }, warn };
  };

  it("new, queued and running threads become error; done and error threads are untouched; the recovered ids are returned and logged", async () => {
    const busy = await Promise.all((["new", "queued", "running"] as const).map((s) => threadWith(s, asked)));
    const done = await threadWith("done", [...asked, answer("x = 4")]);
    const errored = await threadWith("error", [...asked, errorTurn]);
    const doneBefore = await readFile(path.join(root, "data", "threads", done.id, "thread.json"), "utf8");
    const errorBefore = await readFile(path.join(root, "data", "threads", errored.id, "thread.json"), "utf8");
    const { log, warn } = logged();

    const recovered = await recoverBusyThreads({ store, log });

    expect([...recovered].sort()).toEqual(busy.map((t) => t.id).sort());
    for (const t of busy) {
      const after = await store.getThread(t.id);
      expect(after.status).toBe("error");
      expect(after.turns).toEqual(t.turns);
    }
    expect(await readFile(path.join(root, "data", "threads", done.id, "thread.json"), "utf8")).toBe(doneBefore);
    expect(await readFile(path.join(root, "data", "threads", errored.id, "thread.json"), "utf8")).toBe(errorBefore);
    const ids = warn.mock.calls.filter((c) => c[0] === "app.staleThreadRecovered").map((c) => (c[1] as { threadId: string }).threadId);
    expect(ids.sort()).toEqual(busy.map((t) => t.id).sort());
  });

  it("a recovered thread accepts Retry: its last user request is re-queued as a retry", async () => {
    const running = await threadWith("running", asked);
    const followUp = await threadWith("running", [...asked, answer("x = 4"), { role: "user", kind: "text", text: "why?" }]);
    await recoverBusyThreads({ store, log: quietLog });
    const app = createApp(deps);
    await app.handlers.retry(running.id);
    await app.handlers.retry(followUp.id);
    expect(deps.runner.enqueue.mock.calls).toStrictEqual([
      [running.id, { kind: "retry" }],
      [followUp.id, { kind: "retry" }],
    ]);
  });

  it("the first listing after recovery shows them errored, not busy", async () => {
    const running = await threadWith("running", asked);
    await recoverBusyThreads({ store, log: quietLog });
    const listed = await createApp(deps).handlers.listThreads();
    expect(listed.find((t) => t.id === running.id)?.status).toBe("error");
  });

  it("a busy thread whose last turn is already a successful answer becomes done (nothing to retry)", async () => {
    const answered = await threadWith("running", [...asked, answer("x = 4")]);
    const recovered = await recoverBusyThreads({ store, log: quietLog });
    expect(recovered).toEqual([answered.id]);
    expect((await store.getThread(answered.id)).status).toBe("done");
  });

  it("unreadable threads are skipped and never rewritten; the readable ones are still recovered", async () => {
    const running = await threadWith("running", asked);
    const bad = await threadWith("running", asked);
    const file = path.join(root, "data", "threads", bad.id, "thread.json");
    const torn = '{"id":"' + bad.id + '","status":"running","turns":[';
    await writeFile(file, torn);
    expect(await recoverBusyThreads({ store, log: quietLog })).toEqual([running.id]);
    expect(await readFile(file, "utf8")).toBe(torn);
    expect((await store.getThread(running.id)).status).toBe("error");
  });

  it("one thread that cannot be updated is logged and the others are still recovered; it never throws", async () => {
    const a = await threadWith("running", asked);
    const b = await threadWith("queued", asked);
    const failing: Store = {
      ...store,
      updateThread: (id, patch) => (id === a.id ? Promise.reject(new Error("disk full")) : store.updateThread(id, patch)),
    };
    const { log, warn } = logged();
    expect(await recoverBusyThreads({ store: failing, log })).toEqual([b.id]);
    expect((await store.getThread(b.id)).status).toBe("error");
    expect(warn.mock.calls.some((c) => c[0] === "app.staleThreadNotRecovered" && (c[1] as { threadId: string }).threadId === a.id)).toBe(true);
  });

  it("no threads at all, or a listing that fails → [] without throwing", async () => {
    expect(await recoverBusyThreads({ store, log: quietLog })).toEqual([]);
    const broken: Store = { ...store, listThreads: () => Promise.reject(new Error("EACCES")) };
    expect(await recoverBusyThreads({ store: broken, log: quietLog })).toEqual([]);
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

// 077 (Amendment 14): the tray's Appearance handler applies the theme at once, then saves it.
describe("applyTheme (077)", () => {
  function themeSetup(save: (theme: string) => Promise<{ ok: true } | { ok: false; error: string }>) {
    const events: string[] = [];
    const nativeTheme = {
      _source: "dark",
      get themeSource() {
        return this._source;
      },
      set themeSource(v: string) {
        events.push(`themeSource=${v}`);
        this._source = v;
      },
    };
    const config = { theme: "dark" as "dark" | "light" | "system" };
    const warn = vi.fn();
    const log: Logger = { ...quietLog, warn };
    const savePending = vi.fn(async (theme: "dark" | "light" | "system") => {
      events.push(`save ${theme} start`);
      const r = await save(theme);
      events.push(`save ${theme} done`);
      return r;
    });
    return { events, nativeTheme, config, warn, log, save: savePending };
  }

  it("sets nativeTheme.themeSource before the save resolves and updates the config the next window reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = themeSetup(async () => {
      await gate;
      return { ok: true };
    });
    const done = applyTheme("light", { nativeTheme: t.nativeTheme, config: t.config, save: t.save, log: t.log });
    expect(t.nativeTheme.themeSource).toBe("light");
    expect(t.config.theme).toBe("light");
    expect(t.events).toEqual(["themeSource=light", "save light start"]);
    release();
    await done;
    expect(t.events).toEqual(["themeSource=light", "save light start", "save light done"]);
    expect(t.warn).not.toHaveBeenCalled();
  });

  it.each(["dark", "light", "system"] as const)("applies %s", async (theme) => {
    const t = themeSetup(async () => ({ ok: true }));
    t.config.theme = theme === "dark" ? "light" : "dark";
    await applyTheme(theme, { nativeTheme: t.nativeTheme, config: t.config, save: t.save, log: t.log });
    expect(t.nativeTheme.themeSource).toBe(theme);
    expect(t.config.theme).toBe(theme);
    expect(t.save).toHaveBeenCalledWith(theme);
  });

  it("a failed save is logged (theme.saveFailed), not thrown; the theme still applies for this run", async () => {
    const t = themeSetup(async () => ({ ok: false, error: "config.json is not valid JSON" }));
    await expect(applyTheme("light", { nativeTheme: t.nativeTheme, config: t.config, save: t.save, log: t.log })).resolves.toBeUndefined();
    expect(t.nativeTheme.themeSource).toBe("light");
    expect(t.config.theme).toBe("light");
    expect(t.warn).toHaveBeenCalledWith("theme.saveFailed", expect.objectContaining({ theme: "light" }));
  });

  it("a save that throws is logged, not thrown", async () => {
    const t = themeSetup(async () => {
      throw new Error("boom");
    });
    await expect(applyTheme("system", { nativeTheme: t.nativeTheme, config: t.config, save: t.save, log: t.log })).resolves.toBeUndefined();
    expect(t.warn).toHaveBeenCalledWith("theme.saveFailed", expect.objectContaining({ theme: "system" }));
  });
});

// 090 (Amendments 23, 24): tray Transparency applies to the open window at once, then is saved.
describe("applyTransparency (090)", () => {
  it("sets the panel's ground before the save resolves and updates the config", async () => {
    const order: string[] = [];
    const config = { transparency: 20 };
    let release: (v: { ok: true }) => void = () => undefined;
    const done = applyTransparency(50, {
      panel: { setTransparency: (n) => order.push(`panel ${n}`) },
      config,
      save: (n) => {
        order.push(`save ${n}`);
        return new Promise((r) => (release = r));
      },
      log: quietLog,
    });
    expect(order).toEqual(["panel 50", "save 50"]);
    expect(config.transparency).toBe(50);
    release({ ok: true });
    await done;
  });

  it("a failed or throwing save is logged (transparency.saveFailed), not thrown; the window keeps the new value", async () => {
    const warn = vi.fn();
    const set = vi.fn();
    await applyTransparency(90, { panel: { setTransparency: set }, config: { transparency: 20 }, save: async () => ({ ok: false, error: "disk full" }), log: { warn } });
    await applyTransparency(0, {
      panel: { setTransparency: set },
      config: { transparency: 90 },
      save: async () => {
        throw new Error("boom");
      },
      log: { warn },
    });
    expect(set.mock.calls).toEqual([[90], [0]]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["transparency.saveFailed", "transparency.saveFailed"]);
  });
});

// 078 (Amendment 15): choosing a chat in the sidebar makes it current; the next capture continues it.
describe("openThread (078)", () => {
  it("makes the chosen thread the one the next capture appends to", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    const second = await app.onCapture(shot(PNG2));
    expect(second).not.toBe(first);
    await app.handlers.openThread(first);
    expect(await app.onCapture(shot(PNG2))).toBe(first);
    // The fake runner writes no turns: the append is the enqueued request and the saved PNG.
    expect(deps.runner.enqueue.mock.calls.at(-1)).toStrictEqual([first, { kind: "append", screenshot: "002.png" }]);
    expect(await readFile(store.screenshotPath(first, 2))).toEqual(Buffer.from(PNG2));
    expect(existsSync(store.screenshotPath(second, 2))).toBe(false);
  });

  it("clears a pending \"+\": after newThread() then openThread, a capture continues the chosen thread", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    await app.handlers.openThread(first);
    expect(await app.onCapture(shot(PNG2))).toBe(first);
  });

  it("a dictated question after openThread goes to the chosen thread", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    await app.onCapture(shot(PNG2));
    await app.handlers.openThread(first);
    expect(await app.onVoice("why?")).toBe(first);
  });

  it.each([
    ["an unknown thread id", "7d0c5a1e-2b3f-4c6d-8e9f-0a1b2c3d4e5f"],
    ["a non-uuid", "../etc"],
    ["a number", 42],
    ["undefined", undefined],
  ])("%s is rejected with no change: the next capture still continues the current thread", async (_name, bad) => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await expect(app.handlers.openThread(bad as string)).rejects.toThrow();
    expect(await app.onCapture(shot(PNG2))).toBe(first);
  });

  it("an unknown id after \"+\" leaves the \"+\" in place", async () => {
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    await app.handlers.newThread();
    await expect(app.handlers.openThread("7d0c5a1e-2b3f-4c6d-8e9f-0a1b2c3d4e5f")).rejects.toThrow();
    expect(await app.onCapture(shot(PNG2))).not.toBe(first);
  });

  it("a full chosen thread follows 051: the capture starts a new thread seeded with its last answer", async () => {
    deps.config.maxScreenshotsPerThread = 1;
    const app = createApp(deps);
    const first = await app.onCapture(shot(PNG));
    for (const turn of [{ role: "user", kind: "screenshot", file: "001.png" }, answer("The root is 4.")] as Thread["turns"]) {
      await store.appendTurn(first, turn);
    }
    await app.handlers.newThread();
    const other = await app.onCapture(shot(PNG2));
    await app.handlers.openThread(first);
    const next = await app.onCapture(shot(PNG2));
    expect([first, other]).not.toContain(next);
    expect(deps.runner.enqueue).toHaveBeenLastCalledWith(next, { kind: "new", screenshot: "001.png", seed: "The root is 4." });
  });

  it("an errored chosen thread takes the capture as today (appended)", async () => {
    const app = createApp(deps);
    const captured = await app.onCapture(shot(PNG));
    const errored = await erroredThread([{ role: "user", kind: "screenshot", file: "001.png" }, errorTurn]);
    expect(captured).not.toBe(errored.id);
    await app.handlers.openThread(errored.id);
    expect(await app.onCapture(shot(PNG2))).toBe(errored.id);
  });

  it("isAnswering follows the chosen thread", async () => {
    deps.runner.enqueue.mockImplementation(() => new Promise(() => undefined));
    const app = createApp(deps);
    const captured = await app.onCapture(shot(PNG));
    const errored = await erroredThread([{ role: "user", kind: "screenshot", file: "001.png" }, errorTurn]);
    listener?.({ type: "status", threadId: captured, status: "running" });
    await new Promise((r) => setTimeout(r, 20));
    expect(app.isAnswering()).toBe(true);
    await app.handlers.openThread(errored.id);
    expect(app.isAnswering()).toBe(false);
  });
});
