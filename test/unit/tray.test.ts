import { describe, expect, it, vi } from "vitest";
import { createTray, drawTrayIcon, openHistoryFolder, TRAY_LABELS } from "../../src/main/tray";

interface Item {
  label: string;
  click?: () => void;
  type?: string;
  checked?: boolean;
  submenu?: Item[];
}

function setup(theme: "dark" | "light" | "system" = "dark", transparency = 20) {
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
    transparency,
    onTransparency: vi.fn(),
  };
  const tray = createTray(deps);
  const labels = () => trays[0].menu.map((i) => i.label);
  const click = (label: string) => trays[0].menu.find((i) => i.label === label)!.click!();
  const appearance = () => trays[0].menu.find((i) => i.label === "Appearance")!.submenu!;
  const pick = (label: string) => appearance().find((i) => i.label === label)!.click!();
  const transparencyMenu = () => trays[0].menu.find((i) => i.label === "Transparency")!.submenu!;
  const pickTransparency = (label: string) => transparencyMenu().find((i) => i.label === label)!.click!();
  return { tray, deps, trays, labels, click, appearance, pick, transparencyMenu, pickTransparency };
}

describe("tray", () => {
  it("has exactly eight items, in order (058 adds Reset window position; 060 renames Open panel; 077 adds Appearance; 090 Transparency)", () => {
    const { labels, trays, deps } = setup();
    expect(trays).toHaveLength(1);
    expect(trays[0].image).toBe(deps.image);
    expect(labels()).toEqual(["Show/Hide snapsolve (⌃⌥X)", "Reset window position", "Appearance", "Transparency", "Pause hotkeys", "Open history folder", "Clear history", "Quit"]);
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
    expect(labels()).toEqual(["Show/Hide snapsolve (⌃⌥X)", "Reset window position", "Appearance", "Transparency", "Resume hotkeys", "Open history folder", "Clear history", "Quit"]);
    click("Resume hotkeys");
    expect(deps.onResume).toHaveBeenCalledTimes(1);
    expect(labels()[4]).toBe("Pause hotkeys");
  });

  it("setPaused syncs the label without calling the handlers", () => {
    const { tray, labels, deps } = setup();
    tray.setPaused(true);
    expect(labels()[4]).toBe("Resume hotkeys");
    tray.setPaused(false);
    expect(labels()[4]).toBe("Pause hotkeys");
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

  // 090 (Amendments 23, 24): Transparency › 0% (solid), 10% … 90%, applied live by the handler.
  const STEPS = ["0% (solid)", "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%"];

  it.each([
    [20, "20%"],
    [0, "0% (solid)"],
    [90, "90%"],
  ])("Transparency is a submenu after Appearance with ten radio items in order; %i checks %s (090)", (transparency, checkedLabel) => {
    const { transparencyMenu, labels } = setup("dark", transparency);
    expect(labels().indexOf("Transparency")).toBe(labels().indexOf("Appearance") + 1);
    const items = transparencyMenu();
    expect(items.map((i) => i.label)).toEqual(STEPS);
    expect(items.every((i) => i.type === "radio")).toBe(true);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual([checkedLabel]);
    expect(TRAY_LABELS.transparency).toBe("Transparency");
  });

  it("choosing a Transparency step calls onTransparency once with its percent and rebuilds the menu with it checked; the checked one does nothing (090)", () => {
    const { pickTransparency, transparencyMenu, deps } = setup("dark", 20);
    pickTransparency("20%");
    expect(deps.onTransparency).not.toHaveBeenCalled();
    const builds = deps.Menu.buildFromTemplate.mock.calls.length;
    pickTransparency("50%");
    expect(deps.onTransparency).toHaveBeenCalledTimes(1);
    expect(deps.onTransparency).toHaveBeenLastCalledWith(50);
    expect(deps.Menu.buildFromTemplate.mock.calls.length).toBe(builds + 1);
    expect(transparencyMenu().filter((i) => i.checked).map((i) => i.label)).toEqual(["50%"]);
    pickTransparency("50%");
    expect(deps.onTransparency).toHaveBeenCalledTimes(1);
    pickTransparency("0% (solid)");
    expect(deps.onTransparency).toHaveBeenLastCalledWith(0);
    pickTransparency("90%");
    expect(deps.onTransparency).toHaveBeenLastCalledWith(90);
    // The theme is untouched by it.
    expect(deps.onTheme).not.toHaveBeenCalled();
  });

  it("destroy removes the tray", () => {
    const { tray, trays } = setup();
    tray.destroy();
    expect(trays[0].destroyed).toBe(true);
  });
});

// 083 (Amendment 17): four screenshot crop corners framing a bold equals sign; 087 (Amendment 21): drawn about 15%
// smaller, centred, inside a transparent margin.
describe("drawTrayIcon", () => {
  const icon = (size: number) => {
    const buf = drawTrayIcon(size, [9, 105, 218]);
    const opaque = (x: number, y: number) => buf[(y * size + x) * 4 + 3] === 255;
    // The symbol's extent: the bounding box of its opaque pixels.
    let left = size, top = size, right = -1, bottom = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!opaque(x, y)) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    return { buf, opaque, box: { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 } };
  };

  it.each([16, 32])("%i px: BGRA of size², every pixel fully opaque or fully transparent, colour stored B, G, R", (size) => {
    const { buf } = icon(size);
    expect(buf.length).toBe(size * size * 4);
    let opaque = 0;
    for (let k = 3; k < buf.length; k += 4) {
      expect([0, 255]).toContain(buf[k]);
      if (buf[k] === 255) {
        opaque++;
        expect([buf[k - 3], buf[k - 2], buf[k - 1]]).toEqual([218, 105, 9]);
      }
    }
    expect(opaque).toBeGreaterThan(size);
    expect(opaque).toBeLessThan(size * size);
  });

  it.each([16, 32])("%i px: the symbol is 80–90% of the side, square, centred within 1 px, with a transparent edge ring (087)", (size) => {
    const { opaque, box } = icon(size);
    for (const side of [box.width, box.height]) {
      expect(side / size).toBeGreaterThanOrEqual(0.8);
      expect(side / size).toBeLessThanOrEqual(0.9);
    }
    expect(box.width).toBe(box.height);
    expect(Math.abs(box.left - (size - 1 - box.right))).toBeLessThanOrEqual(1);
    expect(Math.abs(box.top - (size - 1 - box.bottom))).toBeLessThanOrEqual(1);
    const s = size - 1;
    for (let k = 0; k < size; k++) {
      for (const [x, y] of [[k, 0], [k, s], [0, k], [s, k]]) expect(opaque(x, y), `edge ${x},${y}`).toBe(false);
    }
  });

  it.each([16, 32])("%i px: four crop corners at the symbol's corners, not a full frame", (size) => {
    const { opaque, box } = icon(size);
    const { left: l, top: t, right: r, bottom: b, width: side } = box;
    const along = Math.round(side * 0.25); // inside an arm (about 30% of the symbol)
    const midX = l + Math.floor(side / 2);
    const midY = t + Math.floor(side / 2);
    for (const [x, y] of [[l, t], [r, t], [l, b], [r, b]]) expect(opaque(x, y), `corner ${x},${y}`).toBe(true);
    // One arm-length along each edge from each corner.
    for (const [x, y] of [
      [l + along, t], [l, t + along], [r - along, t], [r, t + along],
      [l, b - along], [l + along, b], [r, b - along], [r - along, b],
    ]) expect(opaque(x, y), `arm ${x},${y}`).toBe(true);
    // The middle of each edge is open.
    for (const [x, y] of [[midX, t], [midX, b], [l, midY], [r, midY]]) expect(opaque(x, y), `edge middle ${x},${y}`).toBe(false);
  });

  it.each([16, 32])("%i px: two horizontal bars in the middle of the symbol, the centre between them empty", (size) => {
    const { opaque, box } = icon(size);
    const { left: l, top: t, right: r, bottom: b, width: side } = box;
    const stroke = Math.max(2, Math.round(side / 8));
    const mid = l + Math.floor(side / 2);
    // Opaque runs down the symbol's centre column, inside its frame.
    const runs: { top: number; bottom: number }[] = [];
    for (let y = t + stroke; y <= b - stroke; y++) {
      if (!opaque(mid, y)) continue;
      const last = runs[runs.length - 1];
      if (last && last.bottom === y - 1) last.bottom = y;
      else runs.push({ top: y, bottom: y });
    }
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const height = run.bottom - run.top + 1;
      let left = mid;
      let right = mid;
      while (left > 0 && opaque(left - 1, run.top)) left--;
      while (right < size - 1 && opaque(right + 1, run.top)) right++;
      expect(right - left + 1, `bar at y ${run.top}`).toBeGreaterThan(height);
      // A bar, not a full-width line: it stops short of the frame's sides.
      expect(left).toBeGreaterThan(l + stroke);
      expect(right).toBeLessThan(r - stroke);
    }
    expect(opaque(mid, t + Math.floor(side / 2))).toBe(false);
  });

  it.each([16, 32])("%i px: no ring left at the old ring radius on the symbol's diagonal", (size) => {
    const { opaque, box } = icon(size);
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const r = box.width * 0.4; // between the old ring's inner and outer radius
    const off = Math.round(r / Math.SQRT2);
    for (const [x, y] of [[cx - off, cy - off], [cx + off, cy + off], [cx - off, cy + off], [cx + off, cy - off]].map(([x, y]) => [Math.round(x), Math.round(y)])) {
      expect(opaque(x, y), `${x},${y}`).toBe(false);
    }
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
