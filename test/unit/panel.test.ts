import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/main/log";
import {
  computeBounds,
  createAutoHide,
  isSafeExternalUrl,
  resolveSnapsolveUrl,
  TRANSITION_STEPS,
  transitionSteps,
} from "../../src/main/panel";
import { createStore, type Store } from "../../src/main/store";

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("computeBounds", () => {
  const primary = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };

  it("tab: 8 × 72 at the right edge, vertically centered", () => {
    expect(computeBounds("tab", primary, 420)).toEqual({ x: 1272, y: 364, width: 8, height: 72 });
  });

  it("open: panelWidth × work-area height at the right edge", () => {
    expect(computeBounds("open", primary, 420)).toEqual({ x: 860, y: 0, width: 420, height: 800 });
  });

  it("respects a second display's offsets (left of, and above, the primary)", () => {
    const second = { workArea: { x: -1920, y: -200, width: 1920, height: 1040 } };
    expect(computeBounds("tab", second, 420)).toEqual({ x: -8, y: 284, width: 8, height: 72 });
    expect(computeBounds("open", second, 420)).toEqual({ x: -420, y: -200, width: 420, height: 1040 });
    const right = { workArea: { x: 1280, y: 25, width: 1440, height: 875 } };
    expect(computeBounds("open", right, 500)).toEqual({ x: 2220, y: 25, width: 500, height: 875 });
  });

  it("clamps a panelWidth wider than the display to the work area", () => {
    expect(computeBounds("open", primary, 3000)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("always returns whole pixels (odd heights, fractional work areas)", () => {
    const odd = { workArea: { x: 0.5, y: 0, width: 1279.5, height: 801 } };
    for (const state of ["tab", "open"] as const) {
      for (const v of Object.values(computeBounds(state, odd, 420))) expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("transitionSteps", () => {
  const tab = { x: 1272, y: 364, width: 8, height: 72 };
  const open = { x: 860, y: 0, width: 420, height: 800 };

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
