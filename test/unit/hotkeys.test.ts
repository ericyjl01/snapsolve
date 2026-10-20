import { describe, expect, it, vi } from "vitest";
import { CAPTURE_DEBOUNCE_MS, createHotkeys } from "../../src/main/hotkeys";

// No append key (065): a capture continues the current thread. Voice (063): dictate a follow-up.
const KEYS = { capture: "Control+Alt+C", toggle: "Control+Alt+X", voice: "Control+Alt+V" };
const OLD_APPEND = "Control+Alt+Shift+Q";

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
    onToggle: vi.fn(),
    onVoice: vi.fn(),
    notify: vi.fn(),
    now: () => t,
  };
  const hotkeys = createHotkeys(deps);
  return { hotkeys, deps, shortcut, at: (ms: number) => (t = 10_000 + ms) };
}

describe("hotkeys", () => {
  it("registers the three accelerators from config: capture, toggle and voice (063)", () => {
    const { hotkeys, shortcut } = setup({ hotkeys: { capture: "Control+Alt+W", toggle: "Control+Alt+E", voice: "Control+Alt+R" } });
    hotkeys.start();
    expect(shortcut.gs.register.mock.calls.map((c) => c[0]).sort()).toEqual(["Control+Alt+E", "Control+Alt+R", "Control+Alt+W"]);
    expect(hotkeys.status()).toEqual({ capture: true, toggle: true, voice: true, paused: false });
  });

  it("the old append key (065) is never registered, not even when a config object still carries it", () => {
    const { hotkeys, shortcut } = setup({ hotkeys: { ...KEYS, append: OLD_APPEND } as typeof KEYS });
    hotkeys.start();
    hotkeys.pause();
    hotkeys.resume();
    hotkeys.reRegisterIfLost();
    const touched = [...shortcut.gs.register.mock.calls, ...shortcut.gs.unregister.mock.calls].map((c) => c[0]);
    expect(touched).not.toContain(OLD_APPEND);
    expect(shortcut.gs.isRegistered(OLD_APPEND)).toBe(false);
    expect(hotkeys.status()).not.toHaveProperty("append");
  });

  it("toggle press → onToggle, every press (not debounced)", () => {
    const { hotkeys, deps, shortcut, at } = setup();
    hotkeys.start();
    at(0);
    shortcut.press(KEYS.toggle);
    at(10);
    shortcut.press(KEYS.toggle);
    expect(deps.onToggle).toHaveBeenCalledTimes(2);
    expect(deps.onCapture).not.toHaveBeenCalled();
  });

  it("a taken toggle key notifies naming hotkeys.toggle; capture still works", () => {
    const { hotkeys, deps, shortcut } = setup({ taken: [KEYS.toggle] });
    hotkeys.start();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][0]).toBe("Control+Alt+X is taken by another app. Change hotkeys.toggle in config.json.");
    expect(hotkeys.status()).toEqual({ capture: true, toggle: false, voice: true, paused: false });
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
  });

  it("toggle hotkey registered, paused and re-registered with the others", () => {
    const { hotkeys, deps, shortcut } = setup();
    hotkeys.start();
    hotkeys.pause();
    expect(shortcut.gs.isRegistered(KEYS.toggle)).toBe(false);
    shortcut.press(KEYS.toggle);
    expect(deps.onToggle).not.toHaveBeenCalled();
    hotkeys.resume();
    expect(hotkeys.status().toggle).toBe(true);
    shortcut.lose(KEYS.toggle);
    shortcut.gs.register.mockClear();
    hotkeys.reRegisterIfLost();
    expect(shortcut.gs.register.mock.calls.map((c) => c[0])).toEqual([KEYS.toggle]);
    shortcut.press(KEYS.toggle);
    expect(deps.onToggle).toHaveBeenCalledTimes(1);
  });

  it("voice press → onVoice, every press (start, then stop and send; not debounced) (063)", () => {
    const { hotkeys, deps, shortcut, at } = setup();
    hotkeys.start();
    at(0);
    shortcut.press(KEYS.voice);
    at(10);
    shortcut.press(KEYS.voice);
    expect(deps.onVoice).toHaveBeenCalledTimes(2);
    expect(deps.onCapture).not.toHaveBeenCalled();
    expect(deps.onToggle).not.toHaveBeenCalled();
  });

  it("a taken voice key notifies naming hotkeys.voice; capture and toggle still work (063)", () => {
    const { hotkeys, deps, shortcut } = setup({ taken: [KEYS.voice] });
    hotkeys.start();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][0]).toBe("Control+Alt+V is taken by another app. Change hotkeys.voice in config.json.");
    expect(hotkeys.status()).toEqual({ capture: true, toggle: true, voice: false, paused: false });
    shortcut.press(KEYS.capture);
    shortcut.press(KEYS.toggle);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
    expect(deps.onToggle).toHaveBeenCalledTimes(1);
  });

  it("voice hotkey paused and re-registered with the others (063)", () => {
    const { hotkeys, deps, shortcut } = setup();
    hotkeys.start();
    hotkeys.pause();
    shortcut.press(KEYS.voice);
    expect(deps.onVoice).not.toHaveBeenCalled();
    hotkeys.resume();
    shortcut.lose(KEYS.voice);
    shortcut.gs.register.mockClear();
    hotkeys.reRegisterIfLost();
    expect(shortcut.gs.register.mock.calls.map((c) => c[0])).toEqual([KEYS.voice]);
    shortcut.press(KEYS.voice);
    expect(deps.onVoice).toHaveBeenCalledTimes(1);
  });

  it("capture press → onCapture", () => {
    const { hotkeys, deps, shortcut } = setup();
    hotkeys.start();
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
    expect(deps.onToggle).not.toHaveBeenCalled();
  });

  it("register false → notify names the key and hotkeys.capture; the other key still works", () => {
    const { hotkeys, deps, shortcut } = setup({ taken: [KEYS.capture] });
    hotkeys.start();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    const message = deps.notify.mock.calls[0][0] as string;
    expect(message).toContain("Control+Alt+C");
    expect(message).toContain("hotkeys.capture");
    expect(message).not.toContain("hotkeys.toggle");
    expect(hotkeys.status()).toEqual({ capture: false, toggle: true, voice: true, paused: false });
    shortcut.press(KEYS.toggle);
    expect(deps.onToggle).toHaveBeenCalledTimes(1);
  });

  it("register throwing (accelerator Electron rejects) counts as a failure and notifies", () => {
    const { hotkeys, deps } = setup();
    deps.globalShortcut.register.mockImplementationOnce(() => {
      throw new Error("conversion failure");
    });
    expect(() => hotkeys.start()).not.toThrow();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(hotkeys.status().capture === false || hotkeys.status().toggle === false).toBe(true);
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

  it("pause unregisters both, presses do nothing; resume re-registers them", () => {
    const { hotkeys, deps, shortcut } = setup();
    hotkeys.start();
    hotkeys.pause();
    expect(shortcut.gs.isRegistered(KEYS.capture)).toBe(false);
    expect(shortcut.gs.isRegistered(KEYS.toggle)).toBe(false);
    expect(hotkeys.status()).toEqual({ capture: false, toggle: false, voice: false, paused: true });
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).not.toHaveBeenCalled();
    hotkeys.pause();
    hotkeys.resume();
    expect(hotkeys.status()).toEqual({ capture: true, toggle: true, voice: true, paused: false });
    shortcut.press(KEYS.capture);
    expect(deps.onCapture).toHaveBeenCalledTimes(1);
  });

  it("pause unregisters only snapsolve's own keys", () => {
    const { hotkeys, shortcut } = setup();
    hotkeys.start();
    hotkeys.pause();
    expect(shortcut.gs.unregister.mock.calls.map((c) => c[0]).sort()).toEqual([KEYS.capture, KEYS.toggle, KEYS.voice].sort());
  });

  it("reRegisterIfLost re-registers only the missing key", () => {
    const { hotkeys, shortcut } = setup();
    hotkeys.start();
    shortcut.lose(KEYS.capture);
    shortcut.gs.register.mockClear();
    hotkeys.reRegisterIfLost();
    expect(shortcut.gs.register.mock.calls.map((c) => c[0])).toEqual([KEYS.capture]);
    expect(hotkeys.status()).toEqual({ capture: true, toggle: true, voice: true, paused: false });
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
