import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/main/log";
import {
  clampIntoWorkArea,
  computeBounds,
  createAutoHide,
  createPanel,
  isSafeExternalUrl,
  loadWindowBounds,
  OPEN_INSET,
  OPEN_SIZE,
  type PanelDeps,
  type Rect,
  resolveSnapsolveUrl,
  SAVE_DEBOUNCE_MS,
  saveWindowBounds,
  TRANSITION_MS,
  TRANSITION_STEPS,
  transitionSteps,
  type WindowBounds,
} from "../../src/main/panel";
import { createStore, type Store } from "../../src/main/store";

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };
/** A logger that records warning event names. */
function recordingLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { debug() {}, info() {}, warn: (event: string) => void warnings.push(event), error() {}, flush: async () => {}, warnings };
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("computeBounds", () => {
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } };

  it("tab: 8 × 72 at the right edge, vertically centered", () => {
    expect(computeBounds("tab", primary)).toEqual({ x: 1272, y: 364, width: 8, height: 72 });
  });

  it("first open is 360 × 460 at the top-right of the cursor's display (24 px in from the right and top)", () => {
    expect(OPEN_SIZE).toEqual({ width: 360, height: 460 });
    expect(OPEN_INSET).toBe(24);
    expect(computeBounds("open", primary)).toEqual({ x: 1280 - 24 - 360, y: 24, width: 360, height: 460 });
  });

  it("respects a second display's offsets (left of, and above, the primary)", () => {
    const second = { id: 2, workArea: { x: -1920, y: -200, width: 1920, height: 1040 } };
    expect(computeBounds("tab", second)).toEqual({ x: -8, y: 284, width: 8, height: 72 });
    expect(computeBounds("open", second)).toEqual({ x: -384, y: -176, width: 360, height: 460 });
    const right = { id: 3, workArea: { x: 1280, y: 25, width: 1440, height: 875 } };
    expect(computeBounds("open", right)).toEqual({ x: 2336, y: 49, width: 360, height: 460 });
  });

  it("a display smaller than the window: the window is clamped into the work area", () => {
    const tiny = { id: 4, workArea: { x: 0, y: 0, width: 300, height: 400 } };
    expect(computeBounds("open", tiny)).toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });

  it("always returns whole pixels (odd heights, fractional work areas)", () => {
    const odd = { id: 5, workArea: { x: 0.5, y: 0, width: 1279.5, height: 801 } };
    for (const state of ["tab", "open"] as const) {
      for (const v of Object.values(computeBounds(state, odd))) expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("clampIntoWorkArea", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };

  it("a rect that fits is returned unchanged", () => {
    expect(clampIntoWorkArea({ x: 500, y: 300, width: 360, height: 460 }, area)).toEqual({ x: 500, y: 300, width: 360, height: 460 });
  });

  it("saved bounds are clamped into the work area: partly off any edge → moved fully inside, size kept", () => {
    expect(clampIntoWorkArea({ x: 1300, y: 300, width: 360, height: 460 }, area)).toEqual({ x: 1080, y: 300, width: 360, height: 460 });
    expect(clampIntoWorkArea({ x: -100, y: 0, width: 360, height: 460 }, area)).toEqual({ x: 0, y: 25, width: 360, height: 460 });
    expect(clampIntoWorkArea({ x: 400, y: 700, width: 360, height: 460 }, area)).toEqual({ x: 400, y: 440, width: 360, height: 460 });
  });

  it("fully off-screen (display removed, resolution change) → inside, at the nearest edge", () => {
    expect(clampIntoWorkArea({ x: 5000, y: -3000, width: 360, height: 460 }, area)).toEqual({ x: 1080, y: 25, width: 360, height: 460 });
  });

  it("larger than the work area → shrunk to it", () => {
    expect(clampIntoWorkArea({ x: 10, y: 10, width: 2000, height: 1000 }, area)).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  it("whole pixels", () => {
    const r = clampIntoWorkArea({ x: 10.4, y: 30.6, width: 360.5, height: 460.2 }, { x: 0.5, y: 0, width: 1000.5, height: 801 });
    for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("loadWindowBounds (window.json)", () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "snapsolve-window-"));
    file = path.join(root, "window.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("a missing state file → no saved bounds, no warning", async () => {
    const log = recordingLog();
    expect(await loadWindowBounds(file, { log })).toEqual({});
    expect(log.warnings).toEqual([]);
  });

  it("corrupt state file → no saved bounds, a warning is logged, no throw", async () => {
    await writeFile(file, "{ not json");
    const log = recordingLog();
    expect(await loadWindowBounds(file, { log })).toEqual({});
    expect(log.warnings).toEqual(["panel.windowStateUnreadable"]);
  });

  it("valid entries are kept, malformed ones dropped with a warning", async () => {
    await writeFile(
      file,
      JSON.stringify({
        displays: {
          "1": { x: 10, y: 20, width: 360, height: 460 },
          "2": { x: "a", y: 0, width: 360, height: 460 },
          "3": { x: 0, y: 0, width: 0, height: 460 },
          "4": null,
        },
      }),
    );
    const log = recordingLog();
    expect(await loadWindowBounds(file, { log })).toEqual({ "1": { x: 10, y: 20, width: 360, height: 460 } });
    expect(log.warnings).toEqual(["panel.windowStateInvalid"]);
  });

  it("a file that is not { displays: {...} } → no saved bounds and a warning", async () => {
    await writeFile(file, JSON.stringify([1, 2]));
    const log = recordingLog();
    expect(await loadWindowBounds(file, { log })).toEqual({});
    expect(log.warnings).toEqual(["panel.windowStateInvalid"]);
  });

  it("round-trips what saveWindowBounds writes", async () => {
    const saved = { "7": { x: 1, y: 2, width: 360, height: 460 } };
    await saveWindowBounds(file, saved);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ displays: saved });
    expect(await loadWindowBounds(file, { log: recordingLog() })).toEqual(saved);
  });
});

describe("transitionSteps", () => {
  const tab = { x: 1272, y: 364, width: 8, height: 72 };
  const open = { x: 896, y: 24, width: 360, height: 460 };

  it("6 whole-pixel steps that end exactly on the target", () => {
    const steps = transitionSteps(tab, open);
    expect(TRANSITION_STEPS).toBe(6);
    expect(steps).toHaveLength(6);
    expect(steps.at(-1)).toEqual(open);
    for (const r of steps) for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
    const widths = steps.map((r) => r.width);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
    expect(widths[0]).toBeGreaterThan(tab.width);
  });

  it("collapsing goes the other way and ends on the tab", () => {
    expect(transitionSteps(open, tab).at(-1)).toEqual(tab);
  });

  it("from == to still yields 6 identical steps", () => {
    expect(transitionSteps(open, open)).toEqual(Array.from({ length: 6 }, () => open));
  });
});

describe("isSafeExternalUrl (openExternal guard)", () => {
  it.each(["https://example.com/a?b=1#c", "http://example.org", "HTTPS://EXAMPLE.COM/"])("allows %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///C:/Windows/system32/calc.exe",
    "file:///etc/passwd",
    "ms-settings:privacy",
    "mailto:a@example.com",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "snapsolve://app/index.html",
    "data:text/html,<script>alert(1)</script>",
    "https:",
    "//example.com",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["https://example.com"]])("rejects the non-string %j", (value) => {
    expect(isSafeExternalUrl(value)).toBe(false);
  });
});

describe("resolveSnapsolveUrl (snapsolve:// protocol)", () => {
  let root: string;
  let store: Store;
  let rendererDir: string;
  let threadId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "snapsolve-panel-"));
    store = createStore({ dataDir: path.join(root, "data"), projectsDir: path.join(root, "projects"), purge: async () => {}, log: quietLog });
    threadId = (await store.createThread({ model: "opus", effort: "high" })).id;
    await store.saveScreenshot(threadId, PNG);
    rendererDir = path.join(root, "dist", "renderer");
    await mkdir(path.join(rendererDir, "fonts"), { recursive: true });
    await writeFile(path.join(rendererDir, "index.html"), "<!doctype html>");
    await writeFile(path.join(rendererDir, "renderer.js"), "");
    await writeFile(path.join(rendererDir, "katex.min.css"), "");
    await writeFile(path.join(rendererDir, "fonts", "KaTeX_Main-Regular.woff2"), "");
    await writeFile(path.join(rendererDir, "tool.exe"), "");
    await writeFile(path.join(root, "dist", "main.js"), "");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const resolve = (url: string) => resolveSnapsolveUrl(url, { store, rendererDir });

  it("thread/<uuid>/<n>.png → that screenshot inside the thread dir", async () => {
    const got = await resolve(`snapsolve://thread/${threadId}/1.png`);
    expect(got).toEqual({ path: store.screenshotPath(threadId, 1), mime: "image/png" });
    expect(path.dirname(got!.path)).toBe(path.join(root, "data", "threads", threadId));
  });

  it("a missing screenshot of an existing thread → 404", async () => {
    expect(await resolve(`snapsolve://thread/${threadId}/2.png`)).toBeNull();
  });

  it("a well-formed UUID with no thread → 404", async () => {
    expect(await resolve("snapsolve://thread/0b6c1f8e-7d4a-4c2b-9e3f-1a2b3c4d5e6f/1.png")).toBeNull();
  });

  it.each([
    "snapsolve://thread/not-a-uuid/1.png",
    "snapsolve://thread/0B6C1F8E-7D4A-4C2B-9E3F-1A2B3C4D5E6F/1.png",
    "snapsolve://thread/../config.json",
  ])("a non-UUID id → 404 (%s)", async (url) => {
    expect(await resolve(url)).toBeNull();
  });

  it("traversal out of the thread dir → 404", async () => {
    for (const tail of ["../../config.json", "..%2F..%2Fconfig.json", "..%5C..%5Cconfig.json", "%2e%2e/%2e%2e/config.json", "1.png/../../../config.json"]) {
      expect(await resolve(`snapsolve://thread/${threadId}/${tail}`), tail).toBeNull();
    }
  });

  it.each(["0.png", "1000.png", "1.jpg", "1.png.exe", "-1.png", "1e0.png", "thread.json", ""])(
    "a name that is not a screenshot number → 404 (%s)",
    async (name) => {
      expect(await resolve(`snapsolve://thread/${threadId}/${name}`)).toBeNull();
    },
  );

  it("app/<file> → the renderer file with its content type", async () => {
    expect(await resolve("snapsolve://app/index.html")).toEqual({ path: path.join(rendererDir, "index.html"), mime: "text/html" });
    expect(await resolve("snapsolve://app/renderer.js")).toEqual({ path: path.join(rendererDir, "renderer.js"), mime: "text/javascript" });
    expect(await resolve("snapsolve://app/katex.min.css")).toEqual({ path: path.join(rendererDir, "katex.min.css"), mime: "text/css" });
    expect(await resolve("snapsolve://app/fonts/KaTeX_Main-Regular.woff2")).toEqual({
      path: path.join(rendererDir, "fonts", "KaTeX_Main-Regular.woff2"),
      mime: "font/woff2",
    });
  });

  it("app/ traversal, directories, missing files and unknown types → 404", async () => {
    for (const tail of ["../main.js", "%2e%2e/main.js", "..%2Fmain.js", "..%5Cmain.js", "fonts/..%2F..%2Fmain.js", "fonts", "", "missing.js", "tool.exe"]) {
      expect(await resolve(`snapsolve://app/${tail}`), tail).toBeNull();
    }
  });

  it("other hosts, schemes and malformed URLs → 404", async () => {
    for (const url of ["snapsolve://other/index.html", "file:///etc/passwd", `https://thread/${threadId}/1.png`, "not a url", ""]) {
      expect(await resolve(url), url).toBeNull();
    }
  });
});

describe("createAutoHide", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("0 seconds never collapses", () => {
    const onExpire = vi.fn();
    createAutoHide({ seconds: 0, isHeld: () => false, onExpire }).start();
    vi.advanceTimersByTime(3_600_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("collapses once, `seconds` after start", () => {
    const onExpire = vi.fn();
    createAutoHide({ seconds: 2, isHeld: () => false, onExpire }).start();
    vi.advanceTimersByTime(1999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("pauses while held (pointer over the panel / follow-up focused) and resumes after", () => {
    const onExpire = vi.fn();
    let held = true;
    createAutoHide({ seconds: 2, isHeld: () => held, onExpire }).start();
    vi.advanceTimersByTime(3000);
    expect(onExpire).not.toHaveBeenCalled();
    held = false;
    vi.advanceTimersByTime(1999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("stop cancels; a new start runs the full time again", () => {
    const onExpire = vi.fn();
    const timer = createAutoHide({ seconds: 2, isHeld: () => false, onExpire });
    timer.start();
    vi.advanceTimersByTime(1500);
    timer.stop();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.start();
    vi.advanceTimersByTime(1500);
    timer.start();
    vi.advanceTimersByTime(1999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// createPanel over a fake BrowserWindow and screen: the floating window's bounds (task 058).

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler() {}
  send() {}
  isDestroyed() {
    return false;
  }
}

class FakeWindow extends EventEmitter {
  static last: FakeWindow;
  bounds: Rect;
  visible = false;
  webContents = new FakeWebContents();
  /** Every setBounds call, in order. */
  sets: Rect[] = [];
  constructor(readonly options: Record<string, unknown>) {
    super();
    const { x, y, width, height } = options as unknown as Rect;
    this.bounds = { x, y, width, height };
    FakeWindow.last = this;
  }
  setContentProtection() {}
  loadURL() {
    return Promise.resolve();
  }
  setBounds(r: Rect) {
    this.bounds = { ...r };
    this.sets.push({ ...r });
  }
  getBounds() {
    return { ...this.bounds };
  }
  isVisible() {
    return this.visible;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return false;
  }
  /** The user drags the window by its title bar: the OS moves it, then Electron emits `moved`. */
  userMove(x: number, y: number) {
    this.bounds = { ...this.bounds, x, y };
    this.emit("moved");
  }
}

const DISPLAY_A = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const DISPLAY_B = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

function panelSetup(options: { saved?: WindowBounds; cursorOn?: typeof DISPLAY_A } = {}) {
  let cursorDisplay = options.cursorOn ?? DISPLAY_A;
  const displays = [DISPLAY_A, DISPLAY_B];
  const saves: WindowBounds[] = [];
  const deps = {
    BrowserWindow: FakeWindow as unknown as PanelDeps["BrowserWindow"],
    screen: {
      getCursorScreenPoint: () => ({ x: cursorDisplay.workArea.x + 5, y: cursorDisplay.workArea.y + 5 }),
      getDisplayNearestPoint: () => cursorDisplay,
      getDisplayMatching: (r: Rect) => {
        const cx = r.x + r.width / 2;
        return displays.find((d) => cx >= d.workArea.x && cx < d.workArea.x + d.workArea.width) ?? displays[0];
      },
    },
    ipcMain: { handle() {} },
    platform: "darwin" as NodeJS.Platform,
    preloadPath: "/preload.js",
    config: { autoHideSec: 0 },
    log: quietLog,
    bounds: options.saved ?? {},
    saveBounds: vi.fn(async (b: WindowBounds) => void saves.push(structuredClone(b))),
  } satisfies PanelDeps;
  const panel = createPanel(deps);
  const win = FakeWindow.last;
  win.emit("ready-to-show");
  return {
    panel,
    win,
    deps,
    saves,
    moveCursorTo: (d: typeof DISPLAY_A) => {
      cursorDisplay = d;
    },
    /** Lets an open/collapse animation finish. */
    settle: () => vi.advanceTimersByTime(TRANSITION_MS * 2),
  };
}

describe("createPanel: floating window bounds (058)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the window is movable (and still frameless, not resizable)", () => {
    const { win } = panelSetup();
    expect(win.options.movable).toBe(true);
    expect(win.options.frame).toBe(false);
  });

  it("first open is 360 × 460 at the top-right of the cursor's display", () => {
    const { panel, win, settle } = panelSetup();
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 1440 - 24 - 360, y: 25 + 24, width: 360, height: 460 });
  });

  it("open uses saved bounds for the display", () => {
    const { panel, win, settle } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 500, y: 300, width: 360, height: 460 });
  });

  it("saved bounds are clamped into the work area when opened", () => {
    const { panel, win, settle } = panelSetup({ saved: { "1": { x: 1300, y: -50, width: 360, height: 460 } } });
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 1080, y: 25, width: 360, height: 460 });
  });

  it("saved bounds are per display: a rect saved on display A is not used on display B", () => {
    const { panel, win, settle, moveCursorTo } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    moveCursorTo(DISPLAY_B);
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 1440 + 1920 - 24 - 360, y: 24, width: 360, height: 460 });
  });

  it("a user move is saved for its display after the debounce, and the next open comes back there", () => {
    const { panel, win, settle, saves } = panelSetup();
    panel.open();
    settle();
    win.userMove(600, 200);
    win.userMove(620, 210);
    expect(saves).toEqual([]);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(saves).toEqual([{ "1": { x: 620, y: 210, width: 360, height: 460 } }]);
    panel.collapse();
    settle();
    expect(win.getBounds().width).toBe(8);
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 620, y: 210, width: 360, height: 460 });
  });

  it("open while already open on the same display keeps the window where it is (even before the save)", () => {
    const { panel, win, settle } = panelSetup();
    panel.open();
    settle();
    win.userMove(700, 400);
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 700, y: 400, width: 360, height: 460 });
  });

  it("moved during an animation is not saved (transition steps never overwrite the saved rect)", () => {
    const { panel, win, saves, settle } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    panel.open();
    vi.advanceTimersByTime(TRANSITION_MS / TRANSITION_STEPS);
    win.emit("moved");
    vi.advanceTimersByTime(TRANSITION_MS / TRANSITION_STEPS);
    win.emit("moved");
    settle();
    win.emit("moved");
    panel.collapse();
    vi.advanceTimersByTime(TRANSITION_MS / TRANSITION_STEPS);
    win.emit("moved");
    settle();
    win.emit("moved");
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(saves).toEqual([]);
  });

  it("hide/show around a capture keeps the position (hide no longer resets the bounds)", () => {
    const { panel, win, settle } = panelSetup();
    panel.open();
    settle();
    win.userMove(300, 300);
    panel.hide();
    expect(win.isVisible()).toBe(false);
    expect(win.getBounds()).toEqual({ x: 300, y: 300, width: 360, height: 460 });
    panel.show();
    panel.open();
    settle();
    expect(win.getBounds()).toEqual({ x: 300, y: 300, width: 360, height: 460 });
  });

  it("hide in the middle of the open animation lands on the target, not a step", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    panel.open();
    vi.advanceTimersByTime(TRANSITION_MS / TRANSITION_STEPS);
    panel.hide();
    expect(win.getBounds()).toEqual({ x: 500, y: 300, width: 360, height: 460 });
  });

  it("redock clamps instead of snapping: a position that still fits is kept, one that does not is moved inside", () => {
    const { panel, win, settle } = panelSetup();
    panel.open();
    settle();
    win.userMove(400, 300);
    panel.redock();
    expect(win.getBounds()).toEqual({ x: 400, y: 300, width: 360, height: 460 });
    DISPLAY_A.workArea.width = 600;
    try {
      panel.redock();
      expect(win.getBounds()).toEqual({ x: 240, y: 300, width: 360, height: 460 });
    } finally {
      DISPLAY_A.workArea.width = 1440;
    }
  });

  it("redock does not overwrite the saved rect", () => {
    const { panel, win, settle, saves } = panelSetup({ saved: { "1": { x: 1000, y: 300, width: 360, height: 460 } } });
    panel.open();
    settle();
    DISPLAY_A.workArea.width = 600;
    try {
      panel.redock();
      win.emit("moved");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
      expect(saves).toEqual([]);
    } finally {
      DISPLAY_A.workArea.width = 1440;
    }
  });

  it("redock while collapsed keeps the tab on the right edge", () => {
    const { panel, win } = panelSetup();
    panel.redock();
    expect(win.getBounds()).toEqual(computeBounds("tab", DISPLAY_A));
  });

  it("reset clears saved bounds: the entry is deleted, saved, and an open window goes back to the default", () => {
    const { panel, win, settle, saves } = panelSetup({
      saved: { "1": { x: 500, y: 300, width: 360, height: 460 }, "2": { x: 2000, y: 100, width: 360, height: 460 } },
    });
    panel.open();
    settle();
    panel.resetPosition();
    settle();
    expect(saves).toEqual([{}]);
    expect(win.getBounds()).toEqual(computeBounds("open", DISPLAY_A));
    panel.collapse();
    settle();
    panel.open();
    settle();
    expect(win.getBounds()).toEqual(computeBounds("open", DISPLAY_A));
  });

  it("reset while collapsed stays collapsed; the next open is at the default", () => {
    const { panel, win, settle } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    panel.resetPosition();
    settle();
    expect(win.getBounds()).toEqual(computeBounds("tab", DISPLAY_A));
    panel.open();
    settle();
    expect(win.getBounds()).toEqual(computeBounds("open", DISPLAY_A));
  });

  it("a failed save is logged, never thrown", async () => {
    const log = recordingLog();
    const deps = panelSetup().deps;
    const panel = createPanel({ ...deps, log, saveBounds: async () => Promise.reject(new Error("disk full")) });
    const win = FakeWindow.last;
    win.emit("ready-to-show");
    panel.open();
    vi.advanceTimersByTime(TRANSITION_MS * 2);
    win.userMove(100, 100);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(log.warnings).toContain("panel.windowStateSaveFailed");
  });
});
