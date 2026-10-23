// The tray (SPEC §1.2): Show/Hide snapsolve (its hotkey, task 060) · Reset window position (058) · Appearance ›
// Dark / Light / Match macOS (077) · Pause/Resume hotkeys · Open history folder · Clear history · Quit, and a tooltip
// with usage (§3.6). The icon is drawn in code (no image files): a ring with a centre dot.
import type { Theme } from "../shared/types";

export const TRAY_LABELS = {
  toggle: (hotkey: string) => `Show/Hide snapsolve (${hotkey})`,
  resetPosition: "Reset window position",
  appearance: "Appearance",
  themes: { dark: "Dark", light: "Light", system: "Match macOS" } satisfies Record<Theme, string>,
  pause: "Pause hotkeys",
  resume: "Resume hotkeys",
  history: "Open history folder",
  clear: "Clear history",
  quit: "Quit",
} as const;

const TOOLTIP = "snapsolve";

interface MenuItem {
  label: string;
  click?: () => void;
  type?: "radio";
  checked?: boolean;
  submenu?: MenuItem[];
}

const THEME_ORDER: readonly Theme[] = ["dark", "light", "system"];

interface TrayLike {
  setContextMenu(menu: never): void;
  setToolTip(text: string): void;
  destroy(): void;
  /** Windows only (Electron's `Tray.displayBalloon`). */
  displayBalloon?(options: { title: string; content: string }): void;
}

export interface TrayDeps<Image, Menu> {
  Tray: new (image: Image) => TrayLike;
  Menu: { buildFromTemplate(template: MenuItem[]): Menu };
  image: Image;
  /** The show/hide hotkey as the menu names it (`hotkeySymbols`: ⌃⌥X on macOS). */
  toggleHotkey: string;
  /** Show/Hide: toggles the window. */
  onOpenPanel: () => void;
  onResetPosition: () => void;
  /** config.theme at startup: the checked Appearance item. */
  theme: Theme;
  /** Appearance › an item other than the checked one: apply and save it (`applyTheme`). */
  onTheme: (theme: Theme) => void;
  onPause: () => void;
  onResume: () => void;
  onOpenHistory: () => void;
  onClearHistory: () => void;
  onQuit: () => void;
}

export interface TrayControl {
  /** Syncs the Pause/Resume label (e.g. after hotkeys were paused elsewhere) without calling the handlers. */
  setPaused(paused: boolean): void;
  /** Usage text (`5h N% · 7d M%`); "" shows the bare name. */
  setTooltip(usage: string): void;
  /** A tray notification on Windows (SPEC §1.1); main uses `Notification` on macOS. */
  balloon(message: string): void;
  destroy(): void;
}

export function createTray<Image, Menu>(deps: TrayDeps<Image, Menu>): TrayControl {
  const tray = new deps.Tray(deps.image);
  let paused = false;
  let theme = deps.theme;

  function build(): void {
    const template: MenuItem[] = [
      { label: TRAY_LABELS.toggle(deps.toggleHotkey), click: deps.onOpenPanel },
      { label: TRAY_LABELS.resetPosition, click: deps.onResetPosition },
      {
        label: TRAY_LABELS.appearance,
        submenu: THEME_ORDER.map((t) => ({
          label: TRAY_LABELS.themes[t],
          type: "radio" as const,
          checked: t === theme,
          click: () => {
            if (t === theme) return;
            theme = t;
            build();
            deps.onTheme(t);
          },
        })),
      },
      {
        label: paused ? TRAY_LABELS.resume : TRAY_LABELS.pause,
        click: () => {
          paused = !paused;
          build();
          (paused ? deps.onPause : deps.onResume)();
        },
      },
      { label: TRAY_LABELS.history, click: deps.onOpenHistory },
      { label: TRAY_LABELS.clear, click: deps.onClearHistory },
      { label: TRAY_LABELS.quit, click: deps.onQuit },
    ];
    tray.setContextMenu(deps.Menu.buildFromTemplate(template) as never);
  }

  build();
  tray.setToolTip(TOOLTIP);
  return {
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      build();
    },
    setTooltip: (usage) => tray.setToolTip(usage ? `${TOOLTIP} · ${usage}` : TOOLTIP),
    balloon: (message) => tray.displayBalloon?.({ title: TOOLTIP, content: message }),
    destroy: () => tray.destroy(),
  };
}

/**
 * Tray "Open history folder": `dir` is created first (clear history deletes threads/, and opening a missing folder
 * fails silently), then shown in Explorer / Finder. Failures are logged, never thrown.
 */
export async function openHistoryFolder(
  dir: string,
  deps: {
    mkdir: (dir: string, options: { recursive: true }) => Promise<unknown>;
    /** Electron's `shell.openPath`: resolves with an error message, "" on success. */
    openPath: (dir: string) => Promise<string>;
    log: { warn(event: string, fields?: Record<string, unknown>): void };
  },
): Promise<void> {
  try {
    await deps.mkdir(dir, { recursive: true });
  } catch (e) {
    deps.log.warn("tray.openFolderFailed", { dir, error: e });
    return;
  }
  const error = await deps.openPath(dir);
  if (error) deps.log.warn("tray.openFolderFailed", { dir, error });
}

/**
 * A `size`² BGRA bitmap (`nativeImage.createFromBitmap`): a ring and a centre dot in `rgb`, transparent elsewhere.
 * Pixels are either fully opaque or fully transparent, so a macOS template image stays crisp.
 */
export function drawTrayIcon(size: number, rgb: readonly [number, number, number]): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = outer - Math.max(2, size / 8);
  const dot = size * 0.16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if ((d <= outer && d >= inner) || d <= dot) {
        const i = (y * size + x) * 4;
        buf[i] = rgb[2];
        buf[i + 1] = rgb[1];
        buf[i + 2] = rgb[0];
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}
