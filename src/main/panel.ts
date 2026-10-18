// The panel (SPEC §2.2, §4.1–4.4, Amendment 5): one frameless, always-on-top, content-protected window that is either
// an 8 × 72 tab on the right edge or a floating 360 × 460 window the user drags by its title bar (task 058), moved
// between the two in 6 steps over 120 ms and shown with `showInactive`. The open window resizes from its edges (not
// below 280 × 300, task 059); where the user leaves it, and at what size, is saved per display in `<data>/window.json`. It loads the renderer from `snapsolve://app/…` (never file://), serves thumbnails from
// `snapsolve://thread/<uuid>/<n>.png`, denies window.open and navigation, and collapses on Esc (SPEC Amendment 3).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, BrowserWindowConstructorOptions, Input, IpcMainInvokeEvent } from "electron";
import { SnapsolveError } from "../shared/errors";
import type { IpcEvents, IpcRequests } from "../shared/ipc";
import type { Logger } from "./log";
import { isUuid, type Store, writeJsonAtomic } from "./store";

export type PanelState = "tab" | "open";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TAB_WIDTH = 8;
export const TAB_HEIGHT = 72;
/** The floating window's size and its first position: this far in from the work area's right and top edges. */
export const OPEN_SIZE = Object.freeze({ width: 360, height: 460 });
export const OPEN_INSET = 24;
/** The floating window cannot be resized below this (task 059); the tab is exempt. */
export const MIN_SIZE = Object.freeze({ width: 280, height: 300 });
/** A drag fires many `moved`; the position is written once it has rested this long. */
export const SAVE_DEBOUNCE_MS = 300;
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

/** The tab's bounds, or the floating window's default (first-open) bounds, on a display; whole pixels, inside its work area. */
export function computeBounds(state: PanelState, display: { workArea: Rect }): Rect {
  const area = display.workArea;
  const right = Math.round(area.x + area.width);
  if (state === "tab") {
    return { x: right - TAB_WIDTH, y: Math.round(area.y + (area.height - TAB_HEIGHT) / 2), width: TAB_WIDTH, height: TAB_HEIGHT };
  }
  const rect = { x: right - OPEN_INSET - OPEN_SIZE.width, y: area.y + OPEN_INSET, ...OPEN_SIZE };
  return clampIntoWorkArea(rect, area);
}

/** `rect` moved (and shrunk only if larger) so it lies fully inside `area`; whole pixels. */
export function clampIntoWorkArea(rect: Rect, area: Rect): Rect {
  const left = Math.ceil(area.x);
  const top = Math.ceil(area.y);
  const right = Math.floor(area.x + area.width);
  const bottom = Math.floor(area.y + area.height);
  const width = Math.min(Math.round(rect.width), right - left);
  const height = Math.min(Math.round(rect.height), bottom - top);
  const x = Math.min(Math.max(Math.round(rect.x), left), right - width);
  const y = Math.min(Math.max(Math.round(rect.y), top), bottom - height);
  return { x, y, width, height };
}

/** Saved floating-window bounds, keyed by display id (as a string, the JSON key). */
export type WindowBounds = Record<string, Rect>;

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && (r.width as number) > 0 && (r.height as number) > 0;
}

/**
 * Reads `window.json` (`{ displays: { "<id>": Rect } }`). Missing → none saved; unreadable or not that shape →
 * none saved and a warning; malformed entries are dropped with one warning. Never throws.
 */
export async function loadWindowBounds(file: string, deps: { log: Logger }): Promise<WindowBounds> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") deps.log.warn("panel.windowStateUnreadable", { file, error: e });
    return {};
  }
  const displays = (parsed as { displays?: unknown } | null)?.displays;
  if (typeof displays !== "object" || displays === null || Array.isArray(displays)) {
    deps.log.warn("panel.windowStateInvalid", { file });
    return {};
  }
  const saved: WindowBounds = {};
  const dropped: string[] = [];
  for (const [id, rect] of Object.entries(displays)) {
    if (isRect(rect)) saved[id] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    else dropped.push(id);
  }
  if (dropped.length) deps.log.warn("panel.windowStateInvalid", { file, dropped });
  return saved;
}

export function saveWindowBounds(file: string, saved: WindowBounds): Promise<void> {
  return writeJsonAtomic(file, { displays: saved });
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
  id: number;
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
  config: { autoHideSec: number };
  log: Logger;
  /** Saved floating-window bounds per display, as `loadWindowBounds` read them at startup. */
  bounds: WindowBounds;
  /** Persists the whole map (`saveWindowBounds`); a rejection is logged. */
  saveBounds(saved: WindowBounds): Promise<void>;
}

export interface Panel {
  /**
   * Opens on the display under the cursor (the captured display) at that display's saved rect, or the default,
   * clamped into its work area; already open there → stays put. Never takes focus.
   */
  open(): void;
  collapse(): void;
  toggle(): void;
  /** Slid out (the tab does not count). For the capturer's hide path. */
  isOpen(): boolean;
  /** Capture hide path (SPEC §2.2, macOS): hides the window without changing its state; `show` brings it back. */
  hide(): void;
  show(): void;
  /** After display changes (SPEC §4.1): the tab re-docks; the floating window is clamped into its display, not snapped. */
  redock(): void;
  /** Tray "Reset window position": forgets every saved rect; an open window goes back to the default. */
  resetPosition(): void;
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
  /** Where the last moveTo put (or is taking) the window: a `moved` landing there is ours, not the user's. */
  let target: Rect = computeBounds("tab", display);
  let hiddenForCapture = false;
  let saved: WindowBounds = { ...deps.bounds };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const win = new deps.BrowserWindow({
    ...target,
    show: false,
    frame: false,
    // Starts as the tab; resizable (with MIN_SIZE) only while open, see openChrome.
    resizable: false,
    movable: true,
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

  /** Resizable with MIN_SIZE while open and at rest; the tab and the transition steps (smaller than it) are not. */
  function openChrome(on: boolean): void {
    if (win.isDestroyed()) return;
    if (on) {
      win.setResizable(true);
      win.setMinimumSize(MIN_SIZE.width, MIN_SIZE.height);
    } else {
      win.setMinimumSize(0, 0);
      win.setResizable(false);
    }
  }

  function settled(): void {
    animation = undefined;
    if (state === "open") openChrome(true);
  }

  function moveTo(to: Rect, animate: boolean): void {
    clearInterval(animation);
    animation = undefined;
    target = to;
    if (win.isDestroyed()) return;
    if (!animate || !win.isVisible()) {
      if (state === "tab") openChrome(false);
      win.setBounds(to);
      settled();
      return;
    }
    openChrome(false);
    const steps = transitionSteps(win.getBounds(), to);
    let i = 0;
    animation = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(animation);
        return;
      }
      win.setBounds(steps[i++]);
      if (i >= steps.length) {
        clearInterval(animation);
        settled();
      }
    }, TRANSITION_MS / TRANSITION_STEPS);
  }

  /** The floating window's rect on `d`: its saved rect (at least MIN_SIZE), else the default, clamped into its work area. */
  function openBoundsOn(d: DisplayLike): Rect {
    const rect = saved[String(d.id)];
    return rect ? clampIntoWorkArea(atLeastMinimum(rect), d.workArea) : computeBounds("open", d);
  }

  function open(): void {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const stay = state === "open" && cursorDisplay.id === display.id;
    const wasOpen = state === "open";
    display = cursorDisplay;
    state = "open";
    autoHide.stop();
    if (!hiddenForCapture && !win.isVisible()) win.showInactive();
    moveTo(stay ? clampIntoWorkArea(animation ? target : win.getBounds(), display.workArea) : openBoundsOn(display), !wasOpen);
  }

  function collapse(): void {
    autoHide.stop();
    if (state === "tab") return;
    state = "tab";
    moveTo(computeBounds("tab", display), true);
  }

  const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  function persist(): void {
    void deps.saveBounds({ ...saved }).catch((e: unknown) => log.warn("panel.windowStateSaveFailed", { error: e }));
  }

  // A user drag ends in `moved` (title bar) or `resized` (an edge or corner); our own setBounds (transition steps,
  // clamping) are told apart by the animation running or the window sitting exactly on the target we set. A size
  // under MIN_SIZE is put back to it, not saved. Saved per display, after the drag rests.
  const userChanged = () => {
    if (state !== "open" || hiddenForCapture || animation || win.isDestroyed()) return;
    const bounds = win.getBounds();
    if (sameRect(bounds, target)) return;
    if (bounds.width < MIN_SIZE.width || bounds.height < MIN_SIZE.height) {
      moveTo(atLeastMinimum(bounds), false);
      return;
    }
    target = bounds;
    display = screen.getDisplayMatching(bounds);
    clearTimeout(saveTimer);
    const id = String(display.id);
    saveTimer = setTimeout(() => {
      saved = { ...saved, [id]: bounds };
      persist();
    }, SAVE_DEBOUNCE_MS);
  };
  win.on("moved", userChanged);
  win.on("resized", userChanged);

  return {
    window: win,
    open,
    collapse,
    toggle: () => (state === "open" ? collapse() : open()),
    isOpen: () => state === "open" && win.isVisible(),
    hide() {
      hiddenForCapture = true;
      // Mid-transition: land on where it was going, so the window comes back whole; otherwise leave it where it is.
      if (animation) {
        clearInterval(animation);
        win.setBounds(target);
        settled();
      }
      win.hide();
    },
    show() {
      hiddenForCapture = false;
      if (!win.isDestroyed()) win.showInactive();
    },
    redock() {
      display = screen.getDisplayMatching(win.getBounds());
      moveTo(state === "tab" ? computeBounds("tab", display) : clampIntoWorkArea(animation ? target : win.getBounds(), display.workArea), false);
    },
    resetPosition() {
      clearTimeout(saveTimer);
      saved = {};
      persist();
      if (state === "open") moveTo(computeBounds("open", display), win.isVisible());
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

function atLeastMinimum(rect: Rect): Rect {
  return { ...rect, width: Math.max(rect.width, MIN_SIZE.width), height: Math.max(rect.height, MIN_SIZE.height) };
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
