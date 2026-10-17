// The tray (SPEC §1.2): Open panel · Pause/Resume hotkeys · Open history folder · Clear history · Quit, and a
// tooltip with usage (§3.6). The icon is drawn in code (no image files): a ring with a centre dot.

export const TRAY_LABELS = {
  open: "Open panel",
  pause: "Pause hotkeys",
  resume: "Resume hotkeys",
  history: "Open history folder",
  clear: "Clear history",
  quit: "Quit",
} as const;

const TOOLTIP = "snapsolve";

interface MenuItem {
  label: string;
  click: () => void;
}

interface TrayLike {
  setContextMenu(menu: never): void;
  setToolTip(text: string): void;
  destroy(): void;
}

export interface TrayDeps<Image, Menu> {
  Tray: new (image: Image) => TrayLike;
  Menu: { buildFromTemplate(template: MenuItem[]): Menu };
  image: Image;
  onOpenPanel: () => void;
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
  destroy(): void;
}

export function createTray<Image, Menu>(deps: TrayDeps<Image, Menu>): TrayControl {
  const tray = new deps.Tray(deps.image);
  let paused = false;

  function build(): void {
    const template: MenuItem[] = [
      { label: TRAY_LABELS.open, click: deps.onOpenPanel },
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
    destroy: () => tray.destroy(),
  };
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
