import { describe, expect, it, vi } from "vitest";
import { CAPTURE_DEBOUNCE_MS, createHotkeys } from "../../src/main/hotkeys";

const KEYS = { capture: "Control+Alt+C", append: "Control+Alt+Shift+Q" };

/** A globalShortcut stand-in: `taken` accelerators belong to another app; `lose` drops one as the OS can. */
function fakeShortcut(taken: string[] = []) {
  const registered = new Map<string, () => void>();
  const busy = new Set(taken);
  const gs = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (busy.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => void registered.delete(accelerator)),
    isRegistered: vi.fn((accelerator: string) => registered.has(accelerator)),
  };
  return {
    gs,
    press: (accelerator: string) => registered.get(accelerator)?.(),
    lose: (accelerator: string) => registered.delete(accelerator),
    free: (accelerator: string) => busy.delete(accelerator),
  };
}

function setup(options: { taken?: string[]; hotkeys?: typeof KEYS } = {}) {
  const shortcut = fakeShortcut(options.taken);
  let t = 10_000;
  const deps = {
    globalShortcut: shortcut.gs,
    config: { hotkeys: options.hotkeys ?? KEYS },
    onCapture: vi.fn(),
    onAppend: vi.fn(),
    notify: vi.fn(),
    now: () => t,
  };
  const hotkeys = createHotkeys(deps);
  return { hotkeys, deps, shortcut, at: (ms: number) => (t = 10_000 + ms) };
}

describe("hotkeys", () => {
  it("registers both accelerators from config", () => {
    const { hotkeys, shortcut } = setup({ hotkeys: { capture: "Control+Alt+W", append: "Control+Alt+Shift+W" } });
    hotkeys.start();
    expect(shortcut.gs.register.mock.calls.map((c) => c[0]).sort()).toEqual(["Control+Alt+Shift+W", "Control+Alt+W"]);
    expect(hotkeys.status()).toEqual({ capture: true, append: true, paused: false });
  });

  it("capture press → onCapture, append press → onAppend", () => {
    const { hotkeys, deps, shortcut } = setup();
    hotkeys.start();
    shortcut.press(KEYS.capture);
    shortcut.press(KEYS.append);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
    expect(deps.onAppend).toHaveBeenCalledTimes(1);
  });

  it("register false → notify names the key and hotkeys.capture; the other key still works", () => {
    const { hotkeys, deps, shortcut } = setup({ taken: [KEYS.capture] });
    hotkeys.start();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    const message = deps.notify.mock.calls[0][0] as string;
    expect(message).toContain("Control+Alt+C");
    expect(message).toContain("hotkeys.capture");
    expect(message).not.toContain("hotkeys.append");
    expect(hotkeys.status()).toEqual({ capture: false, append: true, paused: false });
    shortcut.press(KEYS.append);
    expect(deps.onAppend).toHaveBeenCalledTimes(1);
  });

  it("a taken append key is named as hotkeys.append", () => {
    const { hotkeys, deps } = setup({ taken: [KEYS.append] });
    hotkeys.start();
    expect(deps.notify.mock.calls[0][0]).toContain("hotkeys.append");
    expect(deps.notify.mock.calls[0][0]).toContain("Control+Alt+Shift+Q");
  });

  it("register throwing (accelerator Electron rejects) counts as a failure and notifies", () => {
    const { hotkeys, deps } = setup();
    deps.globalShortcut.register.mockImplementationOnce(() => {
      throw new Error("conversion failure");
    });
    expect(() => hotkeys.start()).not.toThrow();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(hotkeys.status().capture === false || hotkeys.status().append === false).toBe(true);
  });

  it(`capture presses ${CAPTURE_DEBOUNCE_MS - 1} ms apart → one capture; ${CAPTURE_DEBOUNCE_MS + 1} ms apart → two`, () => {
    expect(CAPTURE_DEBOUNCE_MS).toBe(400);
    const a = setup();
    a.hotkeys.start();
    a.at(0);
    a.shortcut.press(KEYS.capture);
    a.at(399);
    a.shortcut.press(KEYS.capture);
    expect(a.deps.onCapture).toHaveBeenCalledTimes(1);

    const b = setup();
    b.hotkeys.start();
    b.at(0);
    b.shortcut.press(KEYS.capture);
    b.at(401);
    b.shortcut.press(KEYS.capture);
    expect(b.deps.onCapture).toHaveBeenCalledTimes(2);
  });

  it("an ignored press does not restart the debounce window", () => {
    const { hotkeys, deps, shortcut, at } = setup();
    hotkeys.start();
    at(0);
    shortcut.press(KEYS.capture);
    at(300);
    shortcut.press(KEYS.capture);
    at(401);
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(2);
  });

  it("the append key is not debounced", () => {
    const { hotkeys, deps, shortcut, at } = setup();
    hotkeys.start();
    at(0);
    shortcut.press(KEYS.append);
    at(10);
    shortcut.press(KEYS.append);
    expect(deps.onAppend).toHaveBeenCalledTimes(2);
  });

  it("pause unregisters both, presses do nothing; resume re-registers both", () => {
    const { hotkeys, deps, shortcut } = setup();
    hotkeys.start();
    hotkeys.pause();
    expect(shortcut.gs.isRegistered(KEYS.capture)).toBe(false);
    expect(shortcut.gs.isRegistered(KEYS.append)).toBe(false);
    expect(hotkeys.status()).toEqual({ capture: false, append: false, paused: true });
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).not.toHaveBeenCalled();
    hotkeys.pause();
    hotkeys.resume();
    expect(hotkeys.status()).toEqual({ capture: true, append: true, paused: false });
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
  });

  it("pause unregisters only snapsolve's own keys", () => {
    const { hotkeys, shortcut } = setup();
    hotkeys.start();
    hotkeys.pause();
    expect(shortcut.gs.unregister.mock.calls.map((c) => c[0]).sort()).toEqual([KEYS.append, KEYS.capture].sort());
  });

  it("reRegisterIfLost re-registers only the missing key", () => {
    const { hotkeys, shortcut } = setup();
    hotkeys.start();
    shortcut.lose(KEYS.append);
    shortcut.gs.register.mockClear();
    hotkeys.reRegisterIfLost();
    expect(shortcut.gs.register.mock.calls.map((c) => c[0])).toEqual([KEYS.append]);
    expect(hotkeys.status()).toEqual({ capture: true, append: true, paused: false });
  });

  it("reRegisterIfLost does nothing while paused, and picks up a key that was taken at startup once it is free", () => {
    const { hotkeys, shortcut, deps } = setup({ taken: [KEYS.capture] });
    hotkeys.start();
    hotkeys.pause();
    shortcut.gs.register.mockClear();
    hotkeys.reRegisterIfLost();
    expect(shortcut.gs.register).not.toHaveBeenCalled();
    hotkeys.resume();
    shortcut.free(KEYS.capture);
    hotkeys.reRegisterIfLost();
    expect(hotkeys.status().capture).toBe(true);
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
  });

  it("a throwing onCapture does not break the next press", () => {
    const { hotkeys, deps, shortcut, at } = setup();
    deps.onCapture.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    hotkeys.start();
    at(0);
    expect(() => shortcut.press(KEYS.capture)).not.toThrow();
    at(500);
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(2);
  });
});
