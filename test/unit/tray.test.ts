import { describe, expect, it, vi } from "vitest";
import { createTray, drawTrayIcon, TRAY_LABELS } from "../../src/main/tray";

interface Item {
  label: string;
  click: () => void;
}

function setup() {
  const trays: FakeTray[] = [];
  class FakeTray {
    menu: Item[] = [];
    tooltip = "";
    destroyed = false;
    constructor(readonly image: unknown) {
      trays.push(this);
    }
    setContextMenu(menu: Item[]) {
      this.menu = menu;
    }
    setToolTip(text: string) {
      this.tooltip = text;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const deps = {
    Tray: FakeTray,
    Menu: { buildFromTemplate: vi.fn((template: Item[]) => template) },
    image: { icon: true },
    onOpenPanel: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onOpenHistory: vi.fn(),
    onClearHistory: vi.fn(),
    onQuit: vi.fn(),
  };
  const tray = createTray(deps);
  const labels = () => trays[0].menu.map((i) => i.label);
  const click = (label: string) => trays[0].menu.find((i) => i.label === label)!.click();
  return { tray, deps, trays, labels, click };
}

describe("tray", () => {
  it("has exactly five items, in order", () => {
    const { labels, trays, deps } = setup();
    expect(trays).toHaveLength(1);
    expect(trays[0].image).toBe(deps.image);
    expect(labels()).toEqual(["Open panel", "Pause hotkeys", "Open history folder", "Clear history", "Quit"]);
    expect(TRAY_LABELS.resume).toBe("Resume hotkeys");
  });

  it("each item calls its handler", () => {
    const { click, deps } = setup();
    click("Open panel");
    click("Open history folder");
    click("Clear history");
    click("Quit");
    expect(deps.onOpenPanel).toHaveBeenCalledTimes(1);
    expect(deps.onOpenHistory).toHaveBeenCalledTimes(1);
    expect(deps.onClearHistory).toHaveBeenCalledTimes(1);
    expect(deps.onQuit).toHaveBeenCalledTimes(1);
  });

  it("Pause flips to Resume and back, calling onPause / onResume", () => {
    const { click, labels, deps } = setup();
    click("Pause hotkeys");
    expect(deps.onPause).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(["Open panel", "Resume hotkeys", "Open history folder", "Clear history", "Quit"]);
    click("Resume hotkeys");
    expect(deps.onResume).toHaveBeenCalledTimes(1);
    expect(labels()[1]).toBe("Pause hotkeys");
  });

  it("setPaused syncs the label without calling the handlers", () => {
    const { tray, labels, deps } = setup();
    tray.setPaused(true);
    expect(labels()[1]).toBe("Resume hotkeys");
    tray.setPaused(false);
    expect(labels()[1]).toBe("Pause hotkeys");
    expect(deps.onPause).not.toHaveBeenCalled();
    expect(deps.onResume).not.toHaveBeenCalled();
  });

  it("the tooltip is snapsolve, then shows the given usage string", () => {
    const { tray, trays } = setup();
    expect(trays[0].tooltip).toBe("snapsolve");
    tray.setTooltip("5h 12% · 7d 34%");
    expect(trays[0].tooltip).toBe("snapsolve · 5h 12% · 7d 34%");
    tray.setTooltip("");
    expect(trays[0].tooltip).toBe("snapsolve");
  });

  it("destroy removes the tray", () => {
    const { tray, trays } = setup();
    tray.destroy();
    expect(trays[0].destroyed).toBe(true);
  });
});

describe("drawTrayIcon", () => {
  it.each([16, 32])("%i px: BGRA of size², opaque in the ring, transparent corners", (size) => {
    const buf = drawTrayIcon(size, [9, 105, 218]);
    expect(buf.length).toBe(size * size * 4);
    const alpha = (x: number, y: number) => buf[(y * size + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(size - 1, size - 1)).toBe(0);
    let opaque = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] === 255) opaque++;
    expect(opaque).toBeGreaterThan(size); // something is drawn
    expect(opaque).toBeLessThan(size * size); // not a filled square
    // Colour is stored as B, G, R.
    const i = buf.findIndex((_, k) => k % 4 === 3 && buf[k] === 255) - 3;
    expect([buf[i], buf[i + 1], buf[i + 2]]).toEqual([218, 105, 9]);
  });
});
