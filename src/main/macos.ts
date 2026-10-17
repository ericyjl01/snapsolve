// The macOS pieces of startup and the Screen Recording card (SPEC §7.1, §9.1, Amendment 2): a menu-bar app without
// a Dock icon whose claude gets the login shell's PATH, the two argument-free card actions, and hotkey names as
// the platform writes them. The platform is a parameter; every other platform is left untouched.
import type { Logger } from "./log";
import { type ExecFileSyncFn, withLoginShellPath } from "./runner";

/** System Settings › Privacy & Security › Screen Recording. Fixed: the renderer never sends a URL. */
export const SCREEN_RECORDING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

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
}

/** The card's two actions. Both ignore whatever arrives on their channel; the settings one is macOS only. */
export function createPermissionHandlers(deps: {
  platform: NodeJS.Platform;
  /** `shell.openExternal`, here only ever with `SCREEN_RECORDING_SETTINGS_URL`. */
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
