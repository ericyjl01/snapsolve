import { describe, expect, it, vi } from "vitest";
import { createTray, drawTrayIcon, openHistoryFolder, TRAY_LABELS } from "../../src/main/tray";

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
    onResetPosition: vi.fn(),
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
  it("has exactly six items, in order (058 adds Reset window position)", () => {
    const { labels, trays, deps } = setup();
    expect(trays).toHaveLength(1);
    expect(trays[0].image).toBe(deps.image);
    expect(labels()).toEqual(["Open panel", "Reset window position", "Pause hotkeys", "Open history folder", "Clear history", "Quit"]);
    expect(TRAY_LABELS.resume).toBe("Resume hotkeys");
  });

  it("each item calls its handler", () => {
    const { click, deps } = setup();
    click("Open panel");
    click("Reset window position");
    click("Open history folder");
    click("Clear history");
    click("Quit");
    expect(deps.onOpenPanel).toHaveBeenCalledTimes(1);
    expect(deps.onResetPosition).toHaveBeenCalledTimes(1);
    expect(deps.onOpenHistory).toHaveBeenCalledTimes(1);
    expect(deps.onClearHistory).toHaveBeenCalledTimes(1);
    expect(deps.onQuit).toHaveBeenCalledTimes(1);
  });

  it("Pause flips to Resume and back, calling onPause / onResume", () => {
    const { click, labels, deps } = setup();
    click("Pause hotkeys");
    expect(deps.onPause).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(["Open panel", "Reset window position", "Resume hotkeys", "Open history folder", "Clear history", "Quit"]);
    click("Resume hotkeys");
    expect(deps.onResume).toHaveBeenCalledTimes(1);
    expect(labels()[2]).toBe("Pause hotkeys");
  });

  it("setPaused syncs the label without calling the handlers", () => {
    const { tray, labels, deps } = setup();
    tray.setPaused(true);
    expect(labels()[2]).toBe("Resume hotkeys");
    tray.setPaused(false);
    expect(labels()[2]).toBe("Pause hotkeys");
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

describe("openHistoryFolder", () => {
  it("creates the folder first (clear history deletes it), then opens it", async () => {
    const calls: string[] = [];
    const mkdir = vi.fn(async (dir: string) => void calls.push(`mkdir ${dir}`));
    const openPath = vi.fn(async (dir: string) => {
      calls.push(`open ${dir}`);
      return "";
    });
    const warn = vi.fn();
    await openHistoryFolder("/data/threads", { mkdir, openPath, log: { warn } });
    expect(calls).toEqual(["mkdir /data/threads", "open /data/threads"]);
    expect(mkdir).toHaveBeenCalledWith("/data/threads", { recursive: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("an openPath error or a failed mkdir is logged, never thrown", async () => {
    const warn = vi.fn();
    await openHistoryFolder("/d", { mkdir: async () => undefined, openPath: async () => "Failed to open path", log: { warn } });
    expect(warn).toHaveBeenCalledWith("tray.openFolderFailed", expect.objectContaining({ dir: "/d", error: "Failed to open path" }));
    const openPath = vi.fn(async () => "");
    await expect(
      openHistoryFolder("/d", {
        mkdir: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
        openPath,
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe("tray balloon (Windows tray notification)", () => {
  it("balloon shows the message on the tray icon", () => {
    const balloons: unknown[] = [];
    class BalloonTray {
      setContextMenu() {}
      setToolTip() {}
      destroy() {}
      displayBalloon(options: unknown) {
        balloons.push(options);
      }
    }
    const noop = () => undefined;
    const tray = createTray({
      Tray: BalloonTray,
      Menu: { buildFromTemplate: (t: unknown) => t },
      image: {},
      onOpenPanel: noop,
      onPause: noop,
      onResume: noop,
      onOpenHistory: noop,
      onClearHistory: noop,
      onQuit: noop,
    });
    tray.balloon("Control+Alt+Q is taken by another app. Change hotkeys.capture in config.json.");
    expect(balloons).toEqual([{ title: "snapsolve", content: "Control+Alt+Q is taken by another app. Change hotkeys.capture in config.json." }]);
  });
});
