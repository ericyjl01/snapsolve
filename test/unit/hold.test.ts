// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindHold } from "../../src/renderer/hold";

// Task 096: the mic buttons are held to talk. Down on a button → held; up anywhere (the button is hidden by the
// listening bar while held), a cancelled pointer or the window losing focus → let go (it sends what was heard).

function pointer(type: string, button = 0): Event {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button });
}

function key(type: "keydown" | "keyup", k: string, repeat = false): KeyboardEvent {
  return new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, repeat });
}

describe("bindHold (096, mic buttons held to talk)", () => {
  let title: HTMLButtonElement;
  let composer: HTMLButtonElement;
  let other: HTMLElement;
  let calls: boolean[];

  beforeEach(() => {
    document.body.innerHTML = '<button id="voice"></button><div><button id="composer-voice"></button></div><p id="other"></p>';
    title = document.getElementById("voice") as HTMLButtonElement;
    composer = document.getElementById("composer-voice") as HTMLButtonElement;
    other = document.getElementById("other") as HTMLElement;
    // Each test's binding records into its own array: an earlier test's binding (its buttons gone, maybe still held)
    // also listens on window and must not write into this one's.
    const mine: boolean[] = [];
    calls = mine;
    bindHold([title, composer], window, (held) => void mine.push(held));
  });

  it("pointer down on a mic → held once; up anywhere in the window → let go once", () => {
    composer.dispatchEvent(pointer("pointerdown"));
    expect(calls).toEqual([true]);
    composer.dispatchEvent(pointer("pointerdown"));
    expect(calls).toEqual([true]);
    // The composer's mic is hidden while listening: the up lands elsewhere.
    composer.hidden = true;
    other.dispatchEvent(pointer("pointerup"));
    expect(calls).toEqual([true, false]);
    other.dispatchEvent(pointer("pointerup"));
    expect(calls).toEqual([true, false]);
  });

  it("the press's default is prevented (no focus ring or text selection while held)", () => {
    const down = pointer("pointerdown");
    title.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("only the main button holds: a right or middle press does nothing", () => {
    title.dispatchEvent(pointer("pointerdown", 2));
    title.dispatchEvent(pointer("pointerdown", 1));
    other.dispatchEvent(pointer("pointerup", 2));
    expect(calls).toEqual([]);
  });

  it("a cancelled pointer while held lets go (sends)", () => {
    title.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointercancel"));
    expect(calls).toEqual([true, false]);
  });

  it("the window losing focus while held lets go (sends); a blur when not held does nothing", () => {
    window.dispatchEvent(new Event("blur"));
    expect(calls).toEqual([]);
    title.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(new Event("blur"));
    expect(calls).toEqual([true, false]);
  });

  it("a pointer up with nothing held does nothing", () => {
    other.dispatchEvent(pointer("pointerup"));
    window.dispatchEvent(pointer("pointercancel"));
    expect(calls).toEqual([]);
  });

  it("pressing the other mic while one is held does not start a second hold", () => {
    title.dispatchEvent(pointer("pointerdown"));
    composer.dispatchEvent(pointer("pointerdown"));
    other.dispatchEvent(pointer("pointerup"));
    expect(calls).toEqual([true, false]);
  });

  it.each([" ", "Enter"])("the keyboard holds too: %j down on a focused mic → held, key repeats ignored, up → let go", (k) => {
    const down = key("keydown", k);
    title.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    title.dispatchEvent(key("keydown", k, true));
    expect(calls).toEqual([true]);
    title.dispatchEvent(key("keyup", k));
    expect(calls).toEqual([true, false]);
  });

  it("other keys on a mic do nothing", () => {
    title.dispatchEvent(key("keydown", "a"));
    title.dispatchEvent(key("keyup", "a"));
    expect(calls).toEqual([]);
  });

  it("a click (the old toggle) does nothing by itself", () => {
    title.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual([]);
  });

  it("each hold reports through the callback in order, many times", () => {
    const onHold = vi.fn();
    document.body.innerHTML = '<button id="m"></button>';
    const m = document.getElementById("m") as HTMLButtonElement;
    bindHold([m], window, onHold);
    for (let i = 0; i < 3; i++) {
      m.dispatchEvent(pointer("pointerdown"));
      window.dispatchEvent(pointer("pointerup"));
    }
    expect(onHold.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);
  });
});
