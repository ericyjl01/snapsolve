import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/main/log";
import {
  clampIntoWorkArea,
  createAutoHide,
  createPanel,
  defaultBounds,
  isSafeExternalUrl,
  loadWindowBounds,
  FALLBACK_POINTS_PER_INCH,
  MIN_SIZE,
  OPEN_INCHES,
  type PanelDeps,
  type PhysicalSize,
  pointsPerInch,
  type Rect,
  resolveSnapsolveUrl,
  SAVE_DEBOUNCE_MS,
  saveWindowBounds,
  type WindowBounds,
} from "../../src/main/panel";
import { createStore, type Store } from "../../src/main/store";
import type { Theme } from "../../src/shared/types";

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };
/** A logger that records warning event names. */
function recordingLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { debug() {}, info() {}, warn: (event: string) => void warnings.push(event), error() {}, flush: async () => {}, warnings };
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 091 (Amendment 22, replaces 058's 360 × 460 at the top-right): about 9 in × 6 in real size, centred in the work area.
describe("defaultBounds", () => {
  /** `r`'s margins inside `area` differ by at most 1 px each way: centred, whole pixels. */
  const expectCentred = (r: Rect, area: Rect) => {
    for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
    expect(Math.abs(r.x - area.x - (area.x + area.width - r.x - r.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y - area.y - (area.y + area.height - r.y - r.height))).toBeLessThanOrEqual(1);
  };
  const near = (value: number, expected: number) => {
    expect(value).toBeGreaterThanOrEqual(expected * 0.98);
    expect(value).toBeLessThanOrEqual(expected * 1.02);
  };

  it("9 in × 6 in, 110 pt per inch when the physical size is unknown", () => {
    expect(OPEN_INCHES).toEqual({ width: 9, height: 6 });
    expect(FALLBACK_POINTS_PER_INCH).toBe(110);
  });

  it("a 34-inch ultrawide (3440 × 1440, 800 × 335 mm): about 983 × 655, centred", () => {
    const display = { bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 0, width: 3440, height: 1440 } };
    const r = defaultBounds(display, pointsPerInch(display, { width: 800, height: 335 }));
    near(r.width, 983);
    near(r.height, 655);
    expectCentred(r, display.workArea);
  });

  it("a 14-inch MacBook at default scaling (1512 wide, 302 × 189 mm, 1512 × 945 work area): about 1145 × 763, centred", () => {
    const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } };
    const r = defaultBounds(display, pointsPerInch(display, { width: 302, height: 189 }));
    near(r.width, 1145);
    near(r.height, 763);
    expectCentred(r, display.workArea);
  });

  it("points per inch is the display's width in points over its width in inches", () => {
    expect(pointsPerInch({ bounds: { x: 0, y: 0, width: 2540, height: 1000 } }, { width: 508, height: 200 })).toBeCloseTo(127, 10);
  });

  it.each([
    { mm: undefined, why: "missing" },
    { mm: { width: 0, height: 0 }, why: "0 mm (virtual or mirrored)" },
    { mm: { width: -5, height: 100 }, why: "negative" },
    { mm: { width: Number.NaN, height: 100 }, why: "not a number" },
  ] as { mm: PhysicalSize | undefined; why: string }[])("physical size $why → unknown (no points per inch)", ({ mm }) => {
    expect(pointsPerInch({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }, mm)).toBeUndefined();
  });

  it("unknown physical size → 990 × 660 (110 pt per inch), centred", () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 };
    const r = defaultBounds({ workArea: area });
    expect(r).toEqual({ x: 225, y: 133, width: 990, height: 660 });
    expect(defaultBounds({ workArea: area }, undefined)).toEqual(r);
    expectCentred(r, area);
  });

  it("centred in the work area, not the screen: a menu bar and a Dock on the left offset it", () => {
    const area = { x: 80, y: 25, width: 1360, height: 875 };
    const r = defaultBounds({ workArea: area });
    expect(r).toEqual({ x: 80 + 185, y: 133, width: 990, height: 660 });
    expectCentred(r, area);
  });

  it("respects a second display's offsets (left of, and above, the primary)", () => {
    const area = { x: -1920, y: -200, width: 1920, height: 1040 };
    const r = defaultBounds({ workArea: area });
    expect(r).toEqual({ x: -1920 + 465, y: -200 + 190, width: 990, height: 660 });
  });

  it("a work area smaller than 9 × 6 in: shrunk to fit, same centre", () => {
    const wide = { x: 0, y: 25, width: 1024, height: 575 };
    expect(defaultBounds({ workArea: wide })).toEqual({ x: 17, y: 25, width: 990, height: 575 });
    const small = { x: 0, y: 0, width: 800, height: 500 };
    expect(defaultBounds({ workArea: small })).toEqual({ x: 0, y: 0, width: 800, height: 500 });
  });

  it("never below 280 × 300: a display that reports a huge physical size (a projector) still gets the minimum", () => {
    const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const r = defaultBounds(display, pointsPerInch(display, { width: 3000, height: 1700 }));
    expect(r.width).toBe(MIN_SIZE.width);
    expect(r.height).toBe(MIN_SIZE.height);
    expectCentred(r, display.workArea);
  });

  it("a display smaller than the minimum: the window is clamped into the work area", () => {
    expect(defaultBounds({ workArea: { x: 0, y: 0, width: 260, height: 280 } })).toEqual({ x: 0, y: 0, width: 260, height: 280 });
  });

  it("always returns whole pixels (odd heights, fractional work areas and points per inch)", () => {
    for (const v of Object.values(defaultBounds({ workArea: { x: 0.5, y: 0, width: 1279.5, height: 801 } }, 113.37))) {
      expect(Number.isInteger(v)).toBe(true);
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
// createPanel over a fake BrowserWindow and screen: the floating window (058, 059), shown or hidden (060).

class FakeWebContents extends EventEmitter {
  /** CSS injected with insertCSS, by key, while it is in the page (090). */
  css = new Map<string, string>();
  private keys = 0;
  insertCSS(css: string) {
    const key = `css-${++this.keys}`;
    this.css.set(key, css);
    return Promise.resolve(key);
  }
  removeInsertedCSS(key: string) {
    this.css.delete(key);
    return Promise.resolve();
  }
  /** A page load: every injected sheet is gone, then dom-ready. */
  reload() {
    this.css.clear();
    this.emit("dom-ready");
  }
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
  /** Every show, in order: "inactive" (showInactive) or "focus" (show). */
  shows: string[] = [];
  hides = 0;
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
    this.shows.push("inactive");
  }
  show() {
    this.visible = true;
    this.shows.push("focus");
  }
  hide() {
    this.visible = false;
    this.hides++;
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return false;
  }
  /** The user drags an edge or corner: the OS resizes it (left/top edges move x/y too), then Electron emits `resized`. */
  userResize(r: Rect) {
    this.bounds = { ...r };
    this.emit("resized");
  }
  /** The user drags the window by its title bar: the OS moves it, then Electron emits `moved`. */
  userMove(x: number, y: number) {
    this.bounds = { ...this.bounds, x, y };
    this.emit("moved");
  }
}

const DISPLAY_A = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const DISPLAY_B = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
/** 091: with no physical size the default is 990 × 660 (110 pt per inch), centred in A's or B's work area. */
const DEFAULT_A = { x: 225, y: 133, width: 990, height: 660 };
const DEFAULT_B = { x: 1905, y: 210, width: 990, height: 660 };

function panelSetup(
  options: {
    saved?: WindowBounds;
    cursorOn?: typeof DISPLAY_A;
    platform?: NodeJS.Platform;
    onClose?: () => void;
    theme?: Theme;
    transparency?: number;
    /** Each display's physical size in mm (091); none by default. */
    physicalSize?: (displayId: number) => PhysicalSize | undefined;
    log?: Logger;
    /** Records "themeSource=<value>" and "window" in order. */
    events?: string[];
  } = {},
) {
  const events = options.events ?? [];
  const nativeTheme = {
    set themeSource(value: string) {
      events.push(`themeSource=${value}`);
    },
  };
  class OrderedWindow extends FakeWindow {
    constructor(windowOptions: Record<string, unknown>) {
      events.push("window");
      super(windowOptions);
    }
  }
  let cursorDisplay = options.cursorOn ?? DISPLAY_A;
  const displays = [DISPLAY_A, DISPLAY_B];
  const saves: WindowBounds[] = [];
  const deps = {
    BrowserWindow: OrderedWindow as unknown as PanelDeps["BrowserWindow"],
    nativeTheme,
    screen: {
      getCursorScreenPoint: () => ({ x: cursorDisplay.workArea.x + 5, y: cursorDisplay.workArea.y + 5 }),
      getDisplayNearestPoint: () => cursorDisplay,
      getDisplayMatching: (r: Rect) => {
        const cx = r.x + r.width / 2;
        return displays.find((d) => cx >= d.workArea.x && cx < d.workArea.x + d.workArea.width) ?? displays[0];
      },
    },
    ipcMain: { handle() {} },
    platform: options.platform ?? ("darwin" as NodeJS.Platform),
    preloadPath: "/preload.js",
    config: { autoHideSec: 0, theme: options.theme ?? "dark", transparency: options.transparency ?? 20 },
    log: options.log ?? quietLog,
    bounds: options.saved ?? {},
    saveBounds: vi.fn(async (b: WindowBounds) => void saves.push(structuredClone(b))),
    ...(options.physicalSize ? { physicalSize: options.physicalSize } : {}),
    ...(options.onClose ? { onClose: options.onClose } : {}),
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
    /** Lets the save debounce run. */
    rest: () => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS),
  };
}

/** No 8 × 72 tab (or anything smaller than the window's minimum) is ever set. */
function expectNoTab(win: FakeWindow): void {
  for (const r of win.sets) expect(r.width >= MIN_SIZE.width && r.height >= MIN_SIZE.height, JSON.stringify(r)).toBe(true);
}

describe("createPanel: shown or hidden, no tab (060)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts hidden: ready-to-show does not show it, and nothing tab-sized is created", () => {
    const { panel, win } = panelSetup();
    expect(win.isVisible()).toBe(false);
    expect(win.shows).toEqual([]);
    expect(panel.isOpen()).toBe(false);
    expect(win.getBounds()).toEqual(defaultBounds(DISPLAY_A));
    expectNoTab(win);
  });

  it("the window is movable, resizable with a 280 × 300 minimum, frameless", () => {
    const { win } = panelSetup();
    expect(win.options).toMatchObject({ movable: true, resizable: true, minWidth: 280, minHeight: 300, frame: false });
  });

  // 076 (Amendment 13, supersedes 061's vibrancy): terminal-style see-through — no OS blur, only a transparent window
  // under the renderer's ~88% solid ground.
  it("macOS: see-through like a terminal — a transparent window with no vibrancy and no visualEffectState (076)", () => {
    const { win } = panelSetup();
    expect(win.options).toMatchObject({ type: "panel", backgroundColor: "#00000000" });
    expect(win.options).not.toHaveProperty("vibrancy");
    expect(win.options).not.toHaveProperty("visualEffectState");
  });

  // 075: Electron's themeSource drives prefers-color-scheme in the renderer, so it is set before the window exists.
  it.each(["dark", "light", "system"] as const)("theme %s sets nativeTheme.themeSource before the window is created (075)", (theme) => {
    const events: string[] = [];
    panelSetup({ theme, events });
    expect(events).toEqual([`themeSource=${theme}`, "window"]);
  });

  it("off macOS: no vibrancy and an opaque background (061)", () => {
    const { win } = panelSetup({ platform: "win32" });
    expect(win.options.vibrancy).toBeUndefined();
    expect(win.options.visualEffectState).toBeUndefined();
    expect(win.options.backgroundColor).toBe("#ffffff");
    expect(win.options.transparent).toBeUndefined();
  });

  // 090 (Amendment 23): without `transparent: true` Electron ignores the background's alpha and the window is opaque.
  it("macOS: the window is created with transparent: true and a fully transparent background (090)", () => {
    const { win } = panelSetup();
    expect(win.options).toMatchObject({ transparent: true, backgroundColor: "#00000000", frame: false, resizable: true });
  });

  // 090: the ground's alpha is 1 − transparency, injected as CSS (no IPC), again after every page load.
  const injected = (win: FakeWindow) => [...win.webContents.css.values()];
  // These tests run under fake timers: let the insertCSS / removeInsertedCSS promise chain run instead of a timer.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("on dom-ready the page gets the configured ground: 20 → --ground-alpha 0.8 (090)", async () => {
    const { win } = panelSetup({ transparency: 20 });
    win.webContents.emit("dom-ready");
    await settle();
    expect(injected(win)).toHaveLength(1);
    expect(injected(win)[0]).toMatch(/^html:root\s*\{\s*--ground-alpha:\s*0\.8;\s*\}$/);
  });

  it.each([
    [0, "1"],
    [40, "0.6"],
    [90, "0.1"],
  ])("setTransparency(%i) replaces the rule live with --ground-alpha %s, leaving one rule in the page (090)", async (transparency, alpha) => {
    const { panel, win } = panelSetup({ transparency: 20 });
    win.webContents.emit("dom-ready");
    await settle();
    panel.setTransparency(transparency);
    await settle();
    expect(injected(win)).toEqual([`html:root { --ground-alpha: ${alpha}; }`]);
  });

  it("two quick changes end on the last one; a reload re-applies the current value (090)", async () => {
    const { panel, win } = panelSetup({ transparency: 20 });
    win.webContents.emit("dom-ready");
    panel.setTransparency(50);
    panel.setTransparency(70);
    await settle();
    await settle();
    expect(injected(win)).toEqual(["html:root { --ground-alpha: 0.3; }"]);
    win.webContents.reload();
    await settle();
    expect(injected(win)).toEqual(["html:root { --ground-alpha: 0.3; }"]);
  });

  it("hidden state hides the window: close calls win.hide() and no 8 × 72 bounds are ever set", () => {
    const { panel, win } = panelSetup();
    panel.open();
    expect(win.isVisible()).toBe(true);
    panel.close();
    expect(win.isVisible()).toBe(false);
    expect(win.hides).toBe(1);
    expect(panel.isOpen()).toBe(false);
    expectNoTab(win);
  });

  it("onClose runs each time a shown window is hidden (× / Esc / toggle), never for the capture hide path (063: voice stops)", () => {
    const onClose = vi.fn();
    const { panel } = panelSetup({ onClose });
    panel.close();
    expect(onClose).not.toHaveBeenCalled();
    panel.open();
    panel.hide();
    panel.show();
    expect(onClose).not.toHaveBeenCalled();
    panel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    panel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    panel.toggle();
    panel.toggle();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("toggle shows at saved bounds with showInactive (no focus steal), and hides again", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 400, height: 500 } } });
    panel.toggle();
    expect(win.isVisible()).toBe(true);
    expect(win.shows).toEqual(["inactive"]);
    expect(win.getBounds()).toEqual({ x: 500, y: 300, width: 400, height: 500 });
    panel.toggle();
    expect(win.isVisible()).toBe(false);
    panel.toggle();
    expect(win.shows).toEqual(["inactive", "inactive"]);
    expect(win.getBounds()).toEqual({ x: 500, y: 300, width: 400, height: 500 });
    expectNoTab(win);
  });

  it("toggle back shows it exactly where the user left it, before the save has run", () => {
    const { panel, win } = panelSetup();
    panel.toggle();
    win.userMove(300, 100);
    panel.toggle();
    panel.toggle();
    expect(win.getBounds()).toEqual({ x: 300, y: 100, width: 990, height: 660 });
  });

  it("capture shows a hidden window (open), at the cursor display's saved rect, without focus", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 200, y: 200, width: 360, height: 460 } } });
    panel.open();
    expect(win.isVisible()).toBe(true);
    expect(win.shows).toEqual(["inactive"]);
    expect(win.getBounds()).toEqual({ x: 200, y: 200, width: 360, height: 460 });
  });

  it("Esc while focused hides the window", () => {
    const { panel, win } = panelSetup();
    panel.open();
    const prevent = vi.fn();
    win.webContents.emit("before-input-event", { preventDefault: prevent }, { type: "keyDown", key: "Escape" });
    expect(prevent).toHaveBeenCalled();
    expect(win.isVisible()).toBe(false);
  });

  it("the capture hide path keeps a hidden window hidden: show() after a capture does not reveal it", () => {
    const { panel, win } = panelSetup();
    panel.hide();
    panel.show();
    expect(win.isVisible()).toBe(false);
    panel.open();
    panel.hide();
    expect(win.isVisible()).toBe(false);
    panel.show();
    expect(win.isVisible()).toBe(true);
    expect(win.shows.every((s) => s === "inactive")).toBe(true);
  });

  it("a hidden window does not save moves or resizes", () => {
    const { win, saves, rest } = panelSetup();
    win.userMove(10, 30);
    win.userResize({ x: 10, y: 30, width: 500, height: 500 });
    rest();
    expect(saves).toEqual([]);
  });
});

describe("createPanel: floating window bounds (058)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 091 (Amendment 22): the default is 9 × 6 in on the cursor's display, centred in its work area.
  it("first open is the 9 × 6 in default, centred on the cursor's display (990 × 660 with no physical size)", () => {
    const { panel, win } = panelSetup();
    panel.open();
    expect(win.getBounds()).toEqual(DEFAULT_A);
  });

  it("first open uses the display's physical size: 1440 points across 286 mm is 127.9 pt per inch → 1151 × 767", () => {
    const sizes: Record<number, PhysicalSize> = { 1: { width: 286, height: 179 } };
    const { panel, win } = panelSetup({ physicalSize: (id) => sizes[id] });
    panel.open();
    expect(win.getBounds()).toEqual({ x: 145, y: 79, width: 1151, height: 767 });
    expect(win.getBounds()).toEqual(defaultBounds(DISPLAY_A, pointsPerInch(DISPLAY_A, sizes[1])));
  });

  it("each display's own physical size: A known, B unknown → B at 110 pt per inch, and the fallback is logged once for B", () => {
    const infos: [string, unknown][] = [];
    const log: Logger = { ...quietLog, info: (event: string, data?: unknown) => void infos.push([event, data]) };
    const { panel, win, moveCursorTo } = panelSetup({ physicalSize: (id) => (id === 1 ? { width: 286, height: 179 } : undefined), log });
    panel.open();
    expect(infos.filter(([e]) => e === "panel.physicalSizeUnknown")).toEqual([]);
    panel.close();
    moveCursorTo(DISPLAY_B);
    panel.open();
    expect(win.getBounds()).toEqual(DEFAULT_B);
    panel.resetPosition();
    expect(win.getBounds()).toEqual(DEFAULT_B);
    expect(infos.filter(([e]) => e === "panel.physicalSizeUnknown")).toEqual([
      ["panel.physicalSizeUnknown", { display: 2, pointsPerInch: FALLBACK_POINTS_PER_INCH }],
    ]);
  });

  it("the physical size is read when the default is needed, not only when the window was made", () => {
    let sizes: Record<number, PhysicalSize> = {};
    const { panel, win } = panelSetup({ physicalSize: (id) => sizes[id] });
    sizes = { 1: { width: 286, height: 179 } };
    panel.open();
    expect(win.getBounds()).toEqual({ x: 145, y: 79, width: 1151, height: 767 });
  });

  it("open uses saved bounds for the display", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    panel.open();
    expect(win.getBounds()).toEqual({ x: 500, y: 300, width: 360, height: 460 });
  });

  it("saved bounds are clamped into the work area when opened", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 1300, y: -50, width: 360, height: 460 } } });
    panel.open();
    expect(win.getBounds()).toEqual({ x: 1080, y: 25, width: 360, height: 460 });
  });

  it("saved bounds are per display: a rect saved on display A is not used on display B", () => {
    const { panel, win, moveCursorTo } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    moveCursorTo(DISPLAY_B);
    panel.open();
    expect(win.getBounds()).toEqual(DEFAULT_B);
  });

  it("a user move is saved for its display after the debounce, and the next open comes back there", () => {
    const { panel, win, saves, rest } = panelSetup();
    panel.open();
    win.userMove(100, 80);
    win.userMove(120, 90);
    expect(saves).toEqual([]);
    rest();
    expect(saves).toEqual([{ "1": { x: 120, y: 90, width: 990, height: 660 } }]);
    panel.close();
    panel.open();
    expect(win.getBounds()).toEqual({ x: 120, y: 90, width: 990, height: 660 });
  });

  it("open while already shown on the same display keeps the window where it is", () => {
    const { panel, win } = panelSetup();
    panel.open();
    win.userMove(300, 100);
    panel.open();
    expect(win.getBounds()).toEqual({ x: 300, y: 100, width: 990, height: 660 });
  });

  it("bounds main sets itself (open, clamping) are not saved as user moves", () => {
    const { panel, win, saves, rest } = panelSetup({ saved: { "1": { x: 1300, y: 300, width: 360, height: 460 } } });
    panel.open();
    win.emit("moved");
    win.emit("resized");
    rest();
    expect(saves).toEqual([]);
  });

  it("hide/show around a capture keeps the position", () => {
    const { panel, win } = panelSetup();
    panel.open();
    win.userMove(300, 100);
    panel.hide();
    expect(win.isVisible()).toBe(false);
    expect(win.getBounds()).toEqual({ x: 300, y: 100, width: 990, height: 660 });
    panel.show();
    panel.open();
    expect(win.getBounds()).toEqual({ x: 300, y: 100, width: 990, height: 660 });
  });

  it("redock clamps instead of snapping: a position that still fits is kept, one that does not is moved inside", () => {
    const { panel, win } = panelSetup();
    panel.open();
    win.userMove(400, 100);
    panel.redock();
    expect(win.getBounds()).toEqual({ x: 400, y: 100, width: 990, height: 660 });
    DISPLAY_A.workArea.width = 1200;
    try {
      panel.redock();
      expect(win.getBounds()).toEqual({ x: 210, y: 100, width: 990, height: 660 });
    } finally {
      DISPLAY_A.workArea.width = 1440;
    }
  });

  it("redock does not overwrite the saved rect", () => {
    const { panel, win, saves, rest } = panelSetup({ saved: { "1": { x: 1000, y: 300, width: 360, height: 460 } } });
    panel.open();
    DISPLAY_A.workArea.width = 600;
    try {
      panel.redock();
      win.emit("moved");
      rest();
      expect(saves).toEqual([]);
    } finally {
      DISPLAY_A.workArea.width = 1440;
    }
  });

  it("redock while hidden leaves it hidden", () => {
    const { panel, win } = panelSetup();
    panel.redock();
    expect(win.isVisible()).toBe(false);
    expectNoTab(win);
  });

  it("reset clears saved bounds: the entry is deleted, saved, and a shown window goes back to the default", () => {
    const { panel, win, saves } = panelSetup({
      saved: { "1": { x: 500, y: 300, width: 360, height: 460 }, "2": { x: 2000, y: 100, width: 360, height: 460 } },
    });
    panel.open();
    panel.resetPosition();
    expect(saves).toEqual([{}]);
    expect(win.getBounds()).toEqual(defaultBounds(DISPLAY_A));
    panel.close();
    panel.open();
    expect(win.getBounds()).toEqual(defaultBounds(DISPLAY_A));
  });

  it("reset while hidden stays hidden; the next open is at the default", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 500, y: 300, width: 360, height: 460 } } });
    panel.resetPosition();
    expect(win.isVisible()).toBe(false);
    panel.open();
    expect(win.getBounds()).toEqual(defaultBounds(DISPLAY_A));
  });

  it("a failed save is logged, never thrown", async () => {
    const log = recordingLog();
    const deps = panelSetup().deps;
    const panel = createPanel({ ...deps, log, saveBounds: async () => Promise.reject(new Error("disk full")) });
    const win = FakeWindow.last;
    panel.open();
    win.userMove(100, 100);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(log.warnings).toContain("panel.windowStateSaveFailed");
  });
});

describe("createPanel: resizing the floating window (059)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the minimum is 280 × 300", () => {
    expect(MIN_SIZE).toEqual({ width: 280, height: 300 });
  });

  it("no saved size uses the 9 × 6 in default (091)", () => {
    const { panel, win } = panelSetup({ saved: { "2": { x: 1500, y: 50, width: 700, height: 800 } } });
    panel.open();
    expect(win.getBounds()).toEqual(DEFAULT_A);
  });

  it("resize saves width and height (and the x/y a left or top edge moved) for that display", () => {
    const { panel, win, saves, rest } = panelSetup();
    panel.open();
    const { x, y } = win.getBounds();
    win.userResize({ x: x - 140, y, width: 500, height: 600 });
    rest();
    expect(saves).toEqual([{ "1": { x: x - 140, y, width: 500, height: 600 } }]);
  });

  it("the resized window reopens at the new size, also after hide + show around a capture", () => {
    const { panel, win, rest } = panelSetup();
    panel.open();
    win.userResize({ x: 400, y: 100, width: 500, height: 600 });
    rest();
    panel.close();
    panel.open();
    expect(win.getBounds()).toEqual({ x: 400, y: 100, width: 500, height: 600 });
    panel.hide();
    panel.show();
    panel.open();
    expect(win.getBounds()).toEqual({ x: 400, y: 100, width: 500, height: 600 });
  });

  it("below minimum is clamped: a resize under 280 × 300 is neither applied nor saved", () => {
    const { panel, win, saves } = panelSetup();
    panel.open();
    win.userResize({ x: 500, y: 100, width: 200, height: 250 });
    expect(win.getBounds()).toEqual({ x: 500, y: 100, width: 280, height: 300 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(saves).toEqual([]);
  });

  it("a saved size under the minimum (an edited window.json) opens at 280 × 300", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 500, y: 100, width: 100, height: 120 } } });
    panel.open();
    expect(win.getBounds()).toEqual({ x: 500, y: 100, width: 280, height: 300 });
  });

  it("saved size larger than the work area is clamped: a size saved on a big display fits a smaller one", () => {
    const { panel, win } = panelSetup({ saved: { "1": { x: 100, y: 100, width: 1800, height: 1000 } } });
    panel.open();
    expect(win.getBounds()).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  it("redock keeps a resized window's size when it fits, shrinks it when the display got smaller", () => {
    const { panel, win } = panelSetup();
    panel.open();
    win.userResize({ x: 100, y: 100, width: 700, height: 700 });
    panel.redock();
    expect(win.getBounds()).toEqual({ x: 100, y: 100, width: 700, height: 700 });
    DISPLAY_A.workArea.width = 600;
    try {
      panel.redock();
      expect(win.getBounds()).toEqual({ x: 0, y: 100, width: 600, height: 700 });
    } finally {
      DISPLAY_A.workArea.width = 1440;
    }
  });

  it("reset also resets the size to the 9 × 6 in default (091)", () => {
    const { panel, win, saves } = panelSetup({ saved: { "1": { x: 100, y: 100, width: 700, height: 700 } } });
    panel.open();
    panel.resetPosition();
    expect(saves).toEqual([{}]);
    expect(win.getBounds()).toEqual(DEFAULT_A);
  });

  it("reset with a known physical size returns to that display's 9 × 6 in, centred (091)", () => {
    const { panel, win } = panelSetup({
      saved: { "1": { x: 100, y: 100, width: 700, height: 700 } },
      physicalSize: (id) => (id === 1 ? { width: 286, height: 179 } : undefined),
    });
    panel.open();
    expect(win.getBounds()).toEqual({ x: 100, y: 100, width: 700, height: 700 });
    panel.resetPosition();
    expect(win.getBounds()).toEqual({ x: 145, y: 79, width: 1151, height: 767 });
  });
});
