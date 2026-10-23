import { describe, expect, it, vi } from "vitest";
import { createTray, drawTrayIcon, openHistoryFolder, TRAY_LABELS } from "../../src/main/tray";

interface Item {
  label: string;
  click?: () => void;
  type?: string;
  checked?: boolean;
  submenu?: Item[];
}

function setup(theme: "dark" | "light" | "system" = "dark") {
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
    toggleHotkey: "⌃⌥X",
    onOpenPanel: vi.fn(),
    onResetPosition: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onOpenHistory: vi.fn(),
    onClearHistory: vi.fn(),
    onQuit: vi.fn(),
    theme,
    onTheme: vi.fn(),
  };
  const tray = createTray(deps);
  const labels = () => trays[0].menu.map((i) => i.label);
  const click = (label: string) => trays[0].menu.find((i) => i.label === label)!.click!();
  const appearance = () => trays[0].menu.find((i) => i.label === "Appearance")!.submenu!;
  const pick = (label: string) => appearance().find((i) => i.label === label)!.click!();
  return { tray, deps, trays, labels, click, appearance, pick };
}

describe("tray", () => {
  it("has exactly seven items, in order (058 adds Reset window position; 060 renames Open panel; 077 adds Appearance)", () => {
    const { labels, trays, deps } = setup();
    expect(trays).toHaveLength(1);
    expect(trays[0].image).toBe(deps.image);
    expect(labels()).toEqual(["Show/Hide snapsolve (⌃⌥X)", "Reset window position", "Appearance", "Pause hotkeys", "Open history folder", "Clear history", "Quit"]);
    expect(TRAY_LABELS.resume).toBe("Resume hotkeys");
  });

  it("tray item toggles and shows the hotkey (060)", () => {
    const { click, labels, deps } = setup();
    expect(labels()[0]).toBe("Show/Hide snapsolve (⌃⌥X)");
    expect(TRAY_LABELS.toggle("Ctrl+Alt+X")).toBe("Show/Hide snapsolve (Ctrl+Alt+X)");
    click("Show/Hide snapsolve (⌃⌥X)");
    click("Show/Hide snapsolve (⌃⌥X)");
    expect(deps.onOpenPanel).toHaveBeenCalledTimes(2);
    expect(labels()).not.toContain("Open panel");
  });

  it("each item calls its handler", () => {
    const { click, deps } = setup();
    click("Show/Hide snapsolve (⌃⌥X)");
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
    expect(labels()).toEqual(["Show/Hide snapsolve (⌃⌥X)", "Reset window position", "Appearance", "Resume hotkeys", "Open history folder", "Clear history", "Quit"]);
    click("Resume hotkeys");
    expect(deps.onResume).toHaveBeenCalledTimes(1);
    expect(labels()[3]).toBe("Pause hotkeys");
  });

  it("setPaused syncs the label without calling the handlers", () => {
    const { tray, labels, deps } = setup();
    tray.setPaused(true);
    expect(labels()[3]).toBe("Resume hotkeys");
    tray.setPaused(false);
    expect(labels()[3]).toBe("Pause hotkeys");
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

  // 077 (Amendment 14): Appearance › Dark / Light / Match macOS, applied live by the handler.
  it.each([
    ["dark", "Dark"],
    ["light", "Light"],
    ["system", "Match macOS"],
  ] as const)("Appearance is a submenu after Reset window position with three radio items; theme %s checks %s (077)", (theme, checkedLabel) => {
    const { appearance, labels } = setup(theme);
    expect(labels().indexOf("Appearance")).toBe(labels().indexOf("Reset window position") + 1);
    const items = appearance();
    expect(items.map((i) => i.label)).toEqual(["Dark", "Light", "Match macOS"]);
    expect(items.every((i) => i.type === "radio")).toBe(true);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual([checkedLabel]);
    expect(TRAY_LABELS.appearance).toBe("Appearance");
  });

  it("choosing an Appearance item calls onTheme with dark / light / system; the checked one does nothing (077)", () => {
    const { pick, deps } = setup("dark");
    pick("Dark");
    expect(deps.onTheme).not.toHaveBeenCalled();
    pick("Light");
    expect(deps.onTheme).toHaveBeenLastCalledWith("light");
    pick("Match macOS");
    expect(deps.onTheme).toHaveBeenLastCalledWith("system");
    pick("Dark");
    expect(deps.onTheme).toHaveBeenLastCalledWith("dark");
    expect(deps.onTheme).toHaveBeenCalledTimes(3);
  });

  it("after a change the menu is rebuilt with the new item checked, and choosing it again does nothing (077)", () => {
    const { pick, appearance, deps } = setup("dark");
    const builds = deps.Menu.buildFromTemplate.mock.calls.length;
    pick("Light");
    expect(deps.Menu.buildFromTemplate.mock.calls.length).toBe(builds + 1);
    expect(appearance().filter((i) => i.checked).map((i) => i.label)).toEqual(["Light"]);
    pick("Light");
    expect(deps.onTheme).toHaveBeenCalledTimes(1);
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
