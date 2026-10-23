// The tray (SPEC §1.2): Show/Hide snapsolve (its hotkey, task 060) · Reset window position (058) · Appearance ›
// Dark / Light / Match macOS (077) · Transparency › 0% (solid) … 90% (090) · Pause/Resume hotkeys · Open history
// folder · Clear history · Quit, and a tooltip with usage (§3.6). The icon is drawn in code (no image files): crop corners framing an equals sign (083).
import type { Theme } from "../shared/types";

export const TRAY_LABELS = {
  toggle: (hotkey: string) => `Show/Hide snapsolve (${hotkey})`,
  resetPosition: "Reset window position",
  appearance: "Appearance",
  themes: { dark: "Dark", light: "Light", system: "Match macOS" } satisfies Record<Theme, string>,
  transparency: "Transparency",
  step: (percent: number) => (percent === 0 ? "0% (solid)" : `${percent}%`),
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
/** Amendment 24: 10% steps; 100% is left out (the ground would vanish). */
const TRANSPARENCY_STEPS: readonly number[] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

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
  /** config.transparency at startup: the checked Transparency step. */
  transparency: number;
  /** Transparency › a step other than the checked one: apply and save it (`applyTransparency`). */
  onTransparency: (transparency: number) => void;
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
  let transparency = deps.transparency;

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
        label: TRAY_LABELS.transparency,
        submenu: TRANSPARENCY_STEPS.map((step) => ({
          label: TRAY_LABELS.step(step),
          type: "radio" as const,
          checked: step === transparency,
          click: () => {
            if (step === transparency) return;
            transparency = step;
            build();
            deps.onTransparency(step);
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
 * A `size`² BGRA bitmap (`nativeImage.createFromBitmap`) in `rgb`, transparent elsewhere: four screenshot crop
 * corners framing a bold equals sign (083), drawn about 15% smaller in a centred square with a transparent margin
 * (087). Pixels are either fully opaque or fully transparent, so a macOS template image stays crisp.
 */
export function drawTrayIcon(size: number, rgb: readonly [number, number, number]): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  // The symbol's square: the same margin on every side (whole pixels, so it centres exactly), ~85% of the side.
  const margin = Math.round(size * 0.075);
  const side = size - 2 * margin;
  const stroke = Math.max(2, Math.round(side / 8));
  const arm = Math.round(side * 0.3);
  // The bars: an even width so they centre exactly, stacked with a stroke-wide gap.
  const barWidth = 2 * Math.round((side * 0.45) / 2);
  const barLeft = (side - barWidth) / 2;
  const barTop = Math.floor((side - 3 * stroke) / 2);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      // Distances to the symbol's nearest vertical and horizontal edge: a corner is an arm along each.
      const dx = Math.min(x, side - 1 - x);
      const dy = Math.min(y, side - 1 - y);
      const corner = (dy < stroke && dx < arm) || (dx < stroke && dy < arm);
      const inBar = x >= barLeft && x < barLeft + barWidth;
      const row = y - barTop;
      const bar = inBar && ((row >= 0 && row < stroke) || (row >= 2 * stroke && row < 3 * stroke));
      if (corner || bar) {
        const i = ((y + margin) * size + x + margin) * 4;
        buf[i] = rgb[2];
        buf[i + 1] = rgb[1];
        buf[i + 2] = rgb[0];
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}
