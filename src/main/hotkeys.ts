// Global hotkeys (SPEC §1.1, Amendments 10–11): capture, show/hide (task 060) and voice (task 063) from config, capture
// debounced at 400 ms, a
// notification naming the key and its config field when registration fails, pause/resume, and re-registration after
// system resume.
import type { Hotkeys } from "../shared/types";
import type { Logger } from "./log";

export const CAPTURE_DEBOUNCE_MS = 400;

type Name = keyof Hotkeys;
const NAMES: readonly Name[] = ["capture", "toggle", "voice"];

export interface HotkeysDeps {
  /** Electron's `globalShortcut`. */
  globalShortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
    isRegistered(accelerator: string): boolean;
  };
  config: { hotkeys: Hotkeys };
  onCapture: () => void;
  /** Shows or hides the window. */
  onToggle: () => void;
  /** Starts a dictation; pressed again, stops and sends it (voice.ts decides). */
  onVoice: () => void;
  /** Shows a tray notification. */
  notify: (message: string) => void;
  /** How an accelerator is named to the user (macos.ts `hotkeyLabel`); default: as configured. */
  label?: (accelerator: string) => string;
  now?: () => number;
  log?: Pick<Logger, "warn" | "error">;
}

export interface HotkeyStatus {
  capture: boolean;
  toggle: boolean;
  voice: boolean;
  paused: boolean;
}

export interface HotkeysControl {
  /** Registers the keys; a failure notifies once per key and leaves the others working. */
  start(): void;
  /** Unregisters them (only snapsolve's own keys). */
  pause(): void;
  resume(): void;
  /** After system resume: registers any key that is not registered (unless paused). Never notifies. */
  reRegisterIfLost(): void;
  status(): HotkeyStatus;
}

export function createHotkeys(deps: HotkeysDeps): HotkeysControl {
  const { globalShortcut, config } = deps;
  const now = deps.now ?? Date.now;
  let paused = false;
  let lastCapture = Number.NEGATIVE_INFINITY;

  const handlers: Record<Name, () => void> = {
    capture: () => {
      const t = now();
      if (t - lastCapture < CAPTURE_DEBOUNCE_MS) return;
      lastCapture = t;
      run("capture", deps.onCapture);
    },
    toggle: () => run("toggle", deps.onToggle),
    voice: () => run("voice", deps.onVoice),
  };

  function run(name: Name, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      deps.log?.error("hotkeys.handlerFailed", { hotkey: name, error: e });
    }
  }

  function isRegistered(name: Name): boolean {
    try {
      return globalShortcut.isRegistered(config.hotkeys[name]);
    } catch {
      return false;
    }
  }

  /** True when the key is ours afterwards. */
  function register(name: Name): boolean {
    const accelerator = config.hotkeys[name];
    try {
      if (globalShortcut.register(accelerator, handlers[name])) return true;
      deps.log?.warn("hotkeys.taken", { hotkey: name, accelerator });
    } catch (e) {
      deps.log?.warn("hotkeys.registerFailed", { hotkey: name, accelerator, error: e });
    }
    return false;
  }

  function registerAll(notify: boolean): void {
    for (const name of NAMES) {
      if (isRegistered(name)) continue;
      if (!register(name) && notify) {
        const key = deps.label ? deps.label(config.hotkeys[name]) : config.hotkeys[name];
        deps.notify(`${key} is taken by another app. Change hotkeys.${name} in config.json.`);
      }
    }
  }

  return {
    start: () => registerAll(true),
    pause() {
      paused = true;
      for (const name of NAMES) {
        try {
          globalShortcut.unregister(config.hotkeys[name]);
        } catch (e) {
          deps.log?.warn("hotkeys.unregisterFailed", { hotkey: name, error: e });
        }
      }
    },
    resume() {
      paused = false;
      registerAll(true);
    },
    reRegisterIfLost() {
      if (!paused) registerAll(false);
    },
    status: () => ({
      capture: !paused && isRegistered("capture"),
      toggle: !paused && isRegistered("toggle"),
      voice: !paused && isRegistered("voice"),
      paused,
    }),
  };
}
