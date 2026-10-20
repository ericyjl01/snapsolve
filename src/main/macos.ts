// The macOS pieces of startup and the permission cards (SPEC §7.1, §9.1, Amendments 2 and 11): a menu-bar app without
// a Dock icon whose claude gets the login shell's PATH, the argument-free card actions, and hotkey names as the
// platform writes them. The platform is a parameter; every other platform is left untouched.
import type { VoiceDenial } from "../shared/types";
import type { Logger } from "./log";
import { type ExecFileSyncFn, withLoginShellPath } from "./runner";

/** System Settings › Privacy & Security › Screen Recording. Fixed: the renderer never sends a URL. */
export const SCREEN_RECORDING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** The panes a voice card opens (task 063), fixed in main like the one above. */
export const MICROPHONE_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
export const SPEECH_RECOGNITION_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition";

export interface StartupDeps<Tray> {
  platform: NodeJS.Platform;
  /** Electron's `app`; `dock` exists only on macOS. */
  app: { dock?: { hide(): void } };
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  execFileSync: ExecFileSyncFn;
  log: Pick<Logger, "warn">;
  createTray: () => Tray;
}

/**
 * On darwin: hides the Dock icon before the tray appears (an LSUIElement-style menu-bar app also in dev mode) and
 * reads the login PATH once for every claude spawn, logging why when the shell could not give it. Elsewhere: the
 * tray only, and `env` as given.
 */
export function darwinStartup<Tray>(deps: StartupDeps<Tray>): { env: Record<string, string | undefined>; tray: Tray } {
  if (deps.platform !== "darwin") return { env: { ...deps.env }, tray: deps.createTray() };
  deps.app.dock?.hide();
  const tray = deps.createTray();
  const { env, warning } = withLoginShellPath(deps.env, {
    platform: deps.platform,
    home: deps.home,
    execFileSync: deps.execFileSync,
  });
  if (warning) deps.log.warn("app.loginPath", { warning });
  return { env, tray };
}

export interface PermissionHandlers {
  openScreenRecordingSettings(): Promise<void>;
  relaunch(): Promise<void>;
  /** The voice card's Open System Settings: the pane of the permission voice was last refused (task 063). */
  openVoiceSettings(): Promise<void>;
}

/** The cards' actions. Each ignores whatever arrives on its channel; the settings ones are macOS only. */
export function createPermissionHandlers(deps: {
  platform: NodeJS.Platform;
  /** The permission the last dictation was refused; null before any. */
  voiceDenial: () => VoiceDenial | null;
  /** `shell.openExternal`, here only ever with one of the fixed settings URLs above. */
  openExternal: (url: string) => Promise<void>;
  relaunch: () => void;
  exit: () => void;
  log: Pick<Logger, "info">;
}): PermissionHandlers {
  return {
    async openScreenRecordingSettings() {
      if (deps.platform !== "darwin") {
        deps.log.info("app.settingsIgnored", { platform: deps.platform });
        return;
      }
      await deps.openExternal(SCREEN_RECORDING_SETTINGS_URL);
    },
    async relaunch() {
      deps.relaunch();
      deps.exit();
    },
    async openVoiceSettings() {
      if (deps.platform !== "darwin") {
        deps.log.info("app.settingsIgnored", { platform: deps.platform });
        return;
      }
      await deps.openExternal(deps.voiceDenial() === "speechRecognition" ? SPEECH_RECOGNITION_SETTINGS_URL : MICROPHONE_SETTINGS_URL);
    },
  };
}

/** An Electron accelerator as the platform names its keys: "Control+Alt+C" → "Ctrl+Option+C" (macOS), "Ctrl+Alt+C". */
export function hotkeyLabel(accelerator: string, platform: NodeJS.Platform): string {
  const mac = platform === "darwin";
  const names: Record<string, string> = {
    control: "Ctrl",
    ctrl: "Ctrl",
    alt: mac ? "Option" : "Alt",
    option: mac ? "Option" : "Alt",
    altgr: "AltGr",
    shift: "Shift",
    command: "Cmd",
    cmd: "Cmd",
    commandorcontrol: mac ? "Cmd" : "Ctrl",
    cmdorctrl: mac ? "Cmd" : "Ctrl",
    super: mac ? "Cmd" : "Win",
    meta: mac ? "Cmd" : "Win",
  };
  return accelerator
    .split("+")
    .map((key) => names[key.toLowerCase()] ?? key)
    .join("+");
}

const MAC_SYMBOLS: Record<string, string> = {
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  command: "⌘",
  cmd: "⌘",
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  super: "⌘",
  meta: "⌘",
};

/** The menu-bar form of an accelerator: "Control+Alt+X" → "⌃⌥X" on macOS; `hotkeyLabel` elsewhere. */
export function hotkeySymbols(accelerator: string, platform: NodeJS.Platform): string {
  if (platform !== "darwin") return hotkeyLabel(accelerator, platform);
  return accelerator
    .split("+")
    .map((key) => MAC_SYMBOLS[key.toLowerCase()] ?? key)
    .join("");
}
