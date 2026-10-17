// The side panel (SPEC §2.2, §4.1–4.4): one frameless, always-on-top, content-protected window that is either an
// 8 × 72 tab on the right edge or `panelWidth` × work-area height, moved between the two in 6 steps over 120 ms and
// shown with `showInactive`. It loads the renderer from `snapsolve://app/…` (never file://), serves thumbnails from
// `snapsolve://thread/<uuid>/<n>.png`, denies window.open and navigation, and collapses on Esc (SPEC Amendment 3).
import { stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, BrowserWindowConstructorOptions, Input, IpcMainInvokeEvent } from "electron";
import { SnapsolveError } from "../shared/errors";
import type { IpcEvents, IpcRequests } from "../shared/ipc";
import type { Logger } from "./log";
import { isUuid, type Store } from "./store";

export type PanelState = "tab" | "open";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TAB_WIDTH = 8;
export const TAB_HEIGHT = 72;
export const TRANSITION_STEPS = 6;
export const TRANSITION_MS = 120;
export const SCHEME = "snapsolve";
export const RENDERER_URL = `${SCHEME}://app/index.html`;
/** How often the auto-hide timer checks whether it is held. */
const AUTO_HIDE_TICK_MS = 250;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
};
const SCREENSHOT_NAME = /^([1-9]\d{0,2})\.png$/;

/** The window's bounds for `state` on a display (whole pixels; a panel wider than the work area is clamped). */
export function computeBounds(state: PanelState, display: { workArea: Rect }, panelWidth: number): Rect {
  const area = display.workArea;
  const right = Math.round(area.x + area.width);
  if (state === "tab") {
    return { x: right - TAB_WIDTH, y: Math.round(area.y + (area.height - TAB_HEIGHT) / 2), width: TAB_WIDTH, height: TAB_HEIGHT };
  }
  const width = Math.round(Math.min(panelWidth, area.width));
  return { x: right - width, y: Math.round(area.y), width, height: Math.round(area.height) };
}

/** The `TRANSITION_STEPS` bounds from `from` to `to`, evenly spaced, the last exactly `to`. */
export function transitionSteps(from: Rect, to: Rect): Rect[] {
  const at = (a: number, b: number, i: number) => Math.round(a + ((b - a) * i) / TRANSITION_STEPS);
  return Array.from({ length: TRANSITION_STEPS }, (_, k) => {
    const i = k + 1;
    return { x: at(from.x, to.x, i), y: at(from.y, to.y, i), width: at(from.width, to.width, i), height: at(from.height, to.height, i) };
  });
}

/** The renderer may only ask main to open `http:` / `https:` URLs (SPEC §4.4); anything else, or no URL, is refused. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What a `snapsolve://` request serves, or null (404): `app/<file>` → a file inside `rendererDir` of a known type;
 * `thread/<uuid>/<n>.png` → that screenshot, only for an existing thread with a main-generated id.
 */
export async function resolveSnapsolveUrl(
  url: string,
  deps: { store: Pick<Store, "getThread" | "screenshotPath">; rendererDir: string },
): Promise<{ path: string; mime: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:`) return null;
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  // A decoded segment that is empty, a dot segment or holds a separator could leave the directory: never served.
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\\/]/.test(s) || s.includes("\0"))) return null;

  if (parsed.host === "app") {
    const file = path.join(deps.rendererDir, ...segments);
    const rel = path.relative(deps.rendererDir, file);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !(await isFile(file))) return null;
    return { path: file, mime };
  }
  if (parsed.host === "thread") {
    if (segments.length !== 2 || !isUuid(segments[0])) return null;
    const n = SCREENSHOT_NAME.exec(segments[1]);
    if (!n) return null;
    try {
      await deps.store.getThread(segments[0]);
      const file = deps.store.screenshotPath(segments[0], Number(n[1]));
      return (await isFile(file)) ? { path: file, mime: "image/png" } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface AutoHide {
  /** (Re)starts the countdown from the full time. */
  start(): void;
  stop(): void;
}

/**
 * SPEC §4.3: with `seconds` > 0, collapses the panel `seconds` after `start` (a turn's end), not counting time while
 * `isHeld` (pointer over the panel, or the panel focused, i.e. the follow-up box in use). 0 never collapses.
 */
export function createAutoHide(options: { seconds: number; isHeld: () => boolean; onExpire: () => void }): AutoHide {
  let timer: ReturnType<typeof setInterval> | undefined;
  let remaining = 0;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  return {
    start() {
      stop();
      if (options.seconds <= 0) return;
      remaining = options.seconds * 1000;
      timer = setInterval(() => {
        if (options.isHeld()) return;
        remaining -= AUTO_HIDE_TICK_MS;
        if (remaining > 0) return;
        stop();
        options.onExpire();
      }, AUTO_HIDE_TICK_MS);
    },
    stop,
  };
}

interface DisplayLike {
  workArea: Rect;
}

export type PanelHandlers = { [C in keyof IpcRequests]: (...args: IpcRequests[C]["args"]) => Promise<IpcRequests[C]["result"]> };

export interface PanelDeps {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow;
  screen: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): DisplayLike;
    getDisplayMatching(rect: Rect): DisplayLike;
  };
  ipcMain: {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  };
  platform: NodeJS.Platform;
  preloadPath: string;
  config: { panelWidth: number; autoHideSec: number };
  log: Logger;
}

export interface Panel {
  /** Slides out on the display under the cursor (SPEC §4.1: the captured display); never takes focus. */
  open(): void;
  collapse(): void;
  toggle(): void;
  /** Slid out (the tab does not count). For the capturer's hide path. */
  isOpen(): boolean;
  /** Capture hide path (SPEC §2.2, macOS): hides the window without changing its state; `show` brings it back. */
  hide(): void;
  show(): void;
  /** Re-docks on the current display after display changes (SPEC §4.1). */
  redock(): void;
  send<C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]): void;
  /** Answers the renderer's requests; only the panel's own web contents is served. */
  handle(handlers: PanelHandlers): void;
  /** A turn ended: starts the auto-hide countdown when `autoHideSec` > 0. */
  turnEnded(): void;
  window: BrowserWindow;
}

export function createPanel(deps: PanelDeps): Panel {
  const { screen, config, log } = deps;
  let state: PanelState = "tab";
  let display: DisplayLike = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let animation: ReturnType<typeof setInterval> | undefined;
  let hiddenForCapture = false;

  const win = new deps.BrowserWindow({
    ...computeBounds("tab", display, config.panelWidth),
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#ffffff",
    title: "snapsolve",
    ...(deps.platform === "darwin" ? { type: "panel", hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // D18: before the window is ever shown, so it never appears in a capture or a screen share.
  win.setContentProtection(true);

  const autoHide = createAutoHide({
    seconds: config.autoHideSec,
    isHeld: () => {
      if (win.isDestroyed()) return false;
      if (win.isFocused()) return true;
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    },
    onExpire: () => collapse(),
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    log.warn("panel.windowOpenDenied", { scheme: schemeOf(url) });
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    event.preventDefault();
    log.warn("panel.navigationPrevented", { scheme: schemeOf(url) });
  });
  wc.on("will-redirect", (event) => event.preventDefault());
  // Esc while the panel has focus (only a focused window gets key input): handled here, no IPC (SPEC Amendment 3).
  wc.on("before-input-event", (event, input: Input) => {
    if (input.type === "keyDown" && input.key === "Escape" && state === "open") {
      event.preventDefault();
      collapse();
    }
  });
  wc.on("render-process-gone", (_e, details) => log.error("panel.rendererGone", { reason: details.reason }));
  win.once("ready-to-show", () => {
    if (!hiddenForCapture) win.showInactive();
  });
  void win.loadURL(RENDERER_URL).catch((e: unknown) => log.error("panel.loadFailed", { error: e }));

  function moveTo(target: Rect, animate: boolean): void {
    clearInterval(animation);
    animation = undefined;
    if (win.isDestroyed()) return;
    if (!animate || !win.isVisible()) {
      win.setBounds(target);
      return;
    }
    const steps = transitionSteps(win.getBounds(), target);
    let i = 0;
    animation = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(animation);
        return;
      }
      win.setBounds(steps[i++]);
      if (i >= steps.length) {
        clearInterval(animation);
        animation = undefined;
      }
    }, TRANSITION_MS / TRANSITION_STEPS);
  }

  function open(): void {
    display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wasOpen = state === "open";
    state = "open";
    autoHide.stop();
    if (!hiddenForCapture && !win.isVisible()) win.showInactive();
    moveTo(computeBounds("open", display, config.panelWidth), !wasOpen);
  }

  function collapse(): void {
    autoHide.stop();
    if (state === "tab") return;
    state = "tab";
    moveTo(computeBounds("tab", display, config.panelWidth), true);
  }

  return {
    window: win,
    open,
    collapse,
    toggle: () => (state === "open" ? collapse() : open()),
    isOpen: () => state === "open" && win.isVisible(),
    hide() {
      hiddenForCapture = true;
      clearInterval(animation);
      animation = undefined;
      if (state === "open") win.setBounds(computeBounds("open", display, config.panelWidth));
      win.hide();
    },
    show() {
      hiddenForCapture = false;
      if (!win.isDestroyed()) win.showInactive();
    },
    redock() {
      display = screen.getDisplayMatching(win.getBounds());
      moveTo(computeBounds(state, display, config.panelWidth), false);
    },
    send(channel, payload) {
      if (!win.isDestroyed() && !wc.isDestroyed()) wc.send(channel, payload);
    },
    handle(handlers) {
      for (const channel of Object.keys(handlers) as (keyof PanelHandlers)[]) {
        deps.ipcMain.handle(channel, async (event, ...args) => {
          if (event.sender !== wc) throw new SnapsolveError("internal", `${channel} from an unknown sender`);
          return (handlers[channel] as (...a: unknown[]) => Promise<unknown>)(...args);
        });
      }
    },
    turnEnded: () => autoHide.start(),
  };
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "invalid";
  }
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}
