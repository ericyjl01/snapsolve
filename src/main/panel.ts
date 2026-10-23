// The panel (SPEC §2.2, §4.1–4.4, Amendments 5–8): one frameless, always-on-top, content-protected floating window,
// 360 × 460 by default, that the user drags by its title bar (task 058) and resizes from its edges, not below
// 280 × 300 (059). It is either shown (`showInactive`, so focus stays in the user's app) or hidden (`win.hide()`:
// nothing on screen, no tab; 060). Where the user leaves it, and at what size, is saved per display in
// `<data>/window.json`. It loads the renderer from `snapsolve://app/…` (never file://), serves thumbnails from
// `snapsolve://thread/<uuid>/<n>.png`, denies window.open and navigation, and hides on Esc.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, BrowserWindowConstructorOptions, Input, IpcMainInvokeEvent } from "electron";
import { SnapsolveError } from "../shared/errors";
import type { IpcEvents, IpcRequests } from "../shared/ipc";
import type { Theme } from "../shared/types";
import type { Logger } from "./log";
import { isUuid, type Store, writeJsonAtomic } from "./store";

export type PanelState = "hidden" | "open";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The floating window's size and its first position: this far in from the work area's right and top edges. */
export const OPEN_SIZE = Object.freeze({ width: 360, height: 460 });
export const OPEN_INSET = 24;
/** The window cannot be resized below this (task 059). */
export const MIN_SIZE = Object.freeze({ width: 280, height: 300 });
/** A drag fires many `moved`; the position is written once it has rested this long. */
export const SAVE_DEBOUNCE_MS = 300;
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

/** The window's default (first-show) bounds on a display: OPEN_SIZE, OPEN_INSET from the top-right; inside its work area. */
export function defaultBounds(display: { workArea: Rect }): Rect {
  const area = display.workArea;
  const right = Math.round(area.x + area.width);
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
 * SPEC §4.3: with `seconds` > 0, hides the window `seconds` after `start` (a turn's end), not counting time while
 * `isHeld` (pointer over the window, or the window focused, i.e. the follow-up box in use). 0 never hides it.
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
  /** Electron's `nativeTheme`: `themeSource` drives prefers-color-scheme in the renderer (task 075). */
  nativeTheme: { themeSource: Theme };
  config: { autoHideSec: number; theme: Theme; transparency: number };
  log: Logger;
  /** Saved floating-window bounds per display, as `loadWindowBounds` read them at startup. */
  bounds: WindowBounds;
  /** Persists the whole map (`saveWindowBounds`); a rejection is logged. */
  saveBounds(saved: WindowBounds): Promise<void>;
  /** A shown window was hidden (×, Esc, toggle, auto-hide), not the capture hide path: voice stops (task 063). */
  onClose?: () => void;
}

export interface Panel {
  /**
   * Shows the window (a capture, a second launch) on the display under the cursor (the captured display) at that
   * display's saved rect, or the default, clamped into its work area; already shown there → stays put. Never takes focus.
   */
  open(): void;
  /** Hides it: nothing stays on screen (task 060). */
  close(): void;
  /** The show/hide hotkey and the tray item. */
  toggle(): void;
  /** Shown (and not hidden for a capture). For the capturer's hide path. */
  isOpen(): boolean;
  /** Capture hide path (SPEC §2.2, macOS): hides the window without changing its state; `show` brings it back if shown. */
  hide(): void;
  show(): void;
  /** After display changes (SPEC §4.1): a shown window is clamped into its display, not snapped. */
  redock(): void;
  /** Tray "Reset window position": forgets every saved rect; a shown window goes back to the default. */
  resetPosition(): void;
  send<C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]): void;
  /** Answers the renderer's requests; only the panel's own web contents is served. */
  handle(handlers: PanelHandlers): void;
  /** A turn ended: starts the auto-hide countdown when `autoHideSec` > 0. */
  turnEnded(): void;
  /** Tray Transparency (090): how see-through the window's ground is, in percent, applied to the page at once. */
  setTransparency(transparency: number): void;
  window: BrowserWindow;
}

export function createPanel(deps: PanelDeps): Panel {
  const { screen, config, log } = deps;
  let state: PanelState = "hidden";
  let display: DisplayLike = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let saved: WindowBounds = { ...deps.bounds };
  /** Where main last put the window: a `moved`/`resized` landing there is ours, not the user's. */
  let target: Rect = openBoundsOn(display);
  let hiddenForCapture = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // Before the window exists, so its first paint already has the configured look (075).
  deps.nativeTheme.themeSource = config.theme;
  const win = new deps.BrowserWindow({
    ...target,
    show: false,
    frame: false,
    resizable: true,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "snapsolve",
    // macOS (076, Amendment 13): a transparent window with no OS blur, see-through like a terminal under the
    // renderer's ground (its alpha set from `transparency`, 090); elsewhere an opaque window. Electron uses the
    // background's alpha only with `transparent: true`.
    ...(deps.platform === "darwin"
      ? {
          type: "panel",
          hiddenInMissionControl: true,
          acceptFirstMouse: true,
          transparent: true,
          backgroundColor: "#00000000",
        }
      : { backgroundColor: "#ffffff" }),
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
    onExpire: () => close(),
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
  // Esc while the window has focus (only a focused window gets key input): handled here, no IPC (SPEC Amendment 3).
  wc.on("before-input-event", (event, input: Input) => {
    if (input.type === "keyDown" && input.key === "Escape" && state === "open") {
      event.preventDefault();
      close();
    }
  });
  wc.on("render-process-gone", (_e, details) => log.error("panel.rendererGone", { reason: details.reason }));

  // The ground's alpha (090): one injected rule, put in again after every page load and replaced on each change.
  let transparency = config.transparency;
  let groundCss: Promise<string | undefined> = Promise.resolve(undefined);
  function applyGround(loaded: boolean): void {
    groundCss = groundCss
      .then(async (previous) => {
        if (wc.isDestroyed()) return undefined;
        const key = await wc.insertCSS(groundRule(transparency));
        // A page load has already dropped the old rule.
        if (previous !== undefined && !loaded) await wc.removeInsertedCSS(previous);
        return key;
      })
      .catch((e: unknown) => {
        log.warn("panel.groundFailed", { transparency, error: e });
        return undefined;
      });
  }
  wc.on("dom-ready", () => applyGround(true));
  void win.loadURL(RENDERER_URL).catch((e: unknown) => log.error("panel.loadFailed", { error: e }));

  /** The window's rect on `d`: its saved rect (at least MIN_SIZE), else the default, clamped into its work area. */
  function openBoundsOn(d: DisplayLike): Rect {
    const rect = saved[String(d.id)];
    return rect ? clampIntoWorkArea(atLeastMinimum(rect), d.workArea) : defaultBounds(d);
  }

  function moveTo(to: Rect): void {
    target = to;
    if (!win.isDestroyed()) win.setBounds(to);
  }

  function open(): void {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const stay = state === "open" && cursorDisplay.id === display.id;
    display = cursorDisplay;
    state = "open";
    autoHide.stop();
    moveTo(stay ? clampIntoWorkArea(win.getBounds(), display.workArea) : openBoundsOn(display));
    if (!hiddenForCapture && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }

  function close(): void {
    autoHide.stop();
    if (state === "hidden") return;
    state = "hidden";
    if (!win.isDestroyed()) win.hide();
    deps.onClose?.();
  }

  const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  function persist(): void {
    void deps.saveBounds({ ...saved }).catch((e: unknown) => log.warn("panel.windowStateSaveFailed", { error: e }));
  }

  // A user drag ends in `moved` (title bar) or `resized` (an edge or corner); main's own setBounds (open, clamping)
  // are told apart by the window sitting exactly on the target main set. A size under MIN_SIZE is put back to it,
  // not saved. Kept per display.
  const userChanged = () => {
    if (state !== "open" || hiddenForCapture || win.isDestroyed()) return;
    const bounds = win.getBounds();
    if (sameRect(bounds, target)) return;
    if (bounds.width < MIN_SIZE.width || bounds.height < MIN_SIZE.height) {
      moveTo(atLeastMinimum(bounds));
      return;
    }
    target = bounds;
    display = screen.getDisplayMatching(bounds);
    // Remembered at once (a hide + show right after the drag comes back here); written once the drag rests.
    saved = { ...saved, [String(display.id)]: bounds };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
  };
  win.on("moved", userChanged);
  win.on("resized", userChanged);

  return {
    window: win,
    open,
    close,
    toggle: () => (state === "open" ? close() : open()),
    isOpen: () => state === "open" && !win.isDestroyed() && win.isVisible(),
    hide() {
      hiddenForCapture = true;
      if (!win.isDestroyed()) win.hide();
    },
    show() {
      hiddenForCapture = false;
      if (state === "open" && !win.isDestroyed()) win.showInactive();
    },
    redock() {
      display = screen.getDisplayMatching(win.getBounds());
      if (state === "open") moveTo(clampIntoWorkArea(win.getBounds(), display.workArea));
    },
    resetPosition() {
      clearTimeout(saveTimer);
      saved = {};
      persist();
      if (state === "open") moveTo(defaultBounds(display));
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
    setTransparency(next) {
      transparency = next;
      applyGround(false);
    },
  };
}

/** The injected rule (090): the ground's alpha is 1 − transparency; `html:root` outranks the stylesheet's `:root`. */
export function groundRule(transparency: number): string {
  return `html:root { --ground-alpha: ${(100 - transparency) / 100}; }`;
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
