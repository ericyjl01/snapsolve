import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/main/log";
import {
  createVoice,
  ESCAPE,
  holdEscape,
  holdModifiers,
  parseHelperLine,
  resolveSpeechHelper,
  VOICE_BUSY_NOTE,
  VOICE_EMPTY_NOTE,
  VOICE_HOLD_NOTE,
  VOICE_MAX_HOLD_MS,
  VOICE_MIN_HOLD_MS,
  VOICE_STOP_TIMEOUT_MS,
  type VoiceDeps,
} from "../../src/main/voice";
import { userMessage } from "../../src/shared/errors";
import type { VoiceState } from "../../src/shared/types";

const QUESTION = "why the product rule?";
/** Long enough to count as a hold (096). */
const HELD_MS = 1_000;

/** The speech helper as main sees it: JSON lines on stdout, SIGINT = stop and send, any other signal = gone. */
class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 777;
  exitCode: number | null = null;
  signals: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
  line(message: unknown): void {
    this.stdout.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }
  /** As Node does it: stdio ends first, `close` comes after everything printed has been read. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit("exit", code, signal);
      setImmediate(() => this.emit("close", code, signal));
    });
  }
}

/** A globalShortcut stand-in that can press what is registered. */
function fakeShortcut() {
  const registered = new Map<string, () => void>();
  return {
    registered,
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => void registered.delete(accelerator)),
    press: (accelerator: string) => registered.get(accelerator)?.(),
  };
}

function recordingLog() {
  const lines: unknown[][] = [];
  const log: Logger = {
    debug: (...a: unknown[]) => void lines.push(a),
    info: (...a: unknown[]) => void lines.push(a),
    warn: (...a: unknown[]) => void lines.push(a),
    error: (...a: unknown[]) => void lines.push(a),
    flush: async () => {},
  };
  return { log, lines, text: () => JSON.stringify(lines) };
}

function setup(options: { helper?: VoiceDeps["helper"]; spawnThrows?: Error; answering?: boolean; holdKeys?: string[] } = {}) {
  const children: FakeHelper[] = [];
  const spawn = vi.fn((_file: string, _args: readonly string[], _options: unknown) => {
    if (options.spawnThrows) throw options.spawnThrows;
    const child = new FakeHelper();
    children.push(child);
    return child as unknown as ReturnType<VoiceDeps["spawn"]>;
  });
  const shortcut = fakeShortcut();
  const states: VoiceState[] = [];
  const send = vi.fn(async (_text: string) => undefined);
  const onDenied = vi.fn();
  const onFailed = vi.fn();
  const isAnswering = vi.fn(() => options.answering ?? false);
  const showWindow = vi.fn();
  const recorded = recordingLog();
  let clock = 0;
  const deps: VoiceDeps = {
    helper: options.helper === undefined ? { path: "/app/native/snapsolve-speech", prefixArgs: [] } : options.helper,
    spawn,
    env: { PATH: "/usr/bin" },
    globalShortcut: shortcut,
    keyLabel: "⌃⌥V",
    holdKeys: options.holdKeys ?? ["control", "option"],
    onState: (s) => void states.push(s),
    send,
    onDenied,
    onFailed,
    isAnswering,
    showWindow,
    log: recorded.log,
    now: () => clock,
  };
  const voice = createVoice(deps);
  const t = {
    voice,
    deps,
    spawn,
    shortcut,
    states,
    send,
    onDenied,
    onFailed,
    isAnswering,
    showWindow,
    logLines: recorded.lines,
    logText: recorded.text,
    child: () => children.at(-1)!,
    children,
    last: () => states.at(-1),
    /** Moves the voice clock on (the hold's length); timers are separate. */
    tick: (ms: number) => void (clock += ms),
    /** The voice keys held for HELD_MS, then the helper reports them released. */
    holdKeyAndLetGo: async () => {
      voice.press("key");
      t.tick(HELD_MS);
      t.child().line({ type: "released" });
      await flush();
    },
    /** A mic button held for HELD_MS, then let go. */
    holdButtonAndLetGo: () => {
      voice.press("button");
      t.tick(HELD_MS);
      voice.release("button");
    },
  };
  return t;
}

/** Lets stdout lines, exit and close run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

const listening = (text: string, level = 0, hold = true): VoiceState => ({ state: "listening", text, level, key: "⌃⌥V", hold });

describe("parseHelperLine (helper output parsing)", () => {
  it("reads ready, level, partial, final, released and error lines", () => {
    expect(parseHelperLine('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseHelperLine('{"type":"level","level":0.5}')).toEqual({ type: "level", level: 0.5 });
    expect(parseHelperLine('{"type":"partial","text":"why the"}')).toEqual({ type: "partial", text: "why the" });
    expect(parseHelperLine('{"type":"final","text":"why"}')).toEqual({ type: "final", text: "why" });
    // 096: the held voice keys came up.
    expect(parseHelperLine('{"type":"released"}')).toEqual({ type: "released" });
    expect(parseHelperLine('{"type":"error","kind":"micDenied","message":"no"}')).toEqual({
      type: "error",
      kind: "micDenied",
      message: "no",
    });
  });

  it("clamps a level into 0…1", () => {
    expect(parseHelperLine('{"type":"level","level":7}')).toEqual({ type: "level", level: 1 });
    expect(parseHelperLine('{"type":"level","level":-2}')).toEqual({ type: "level", level: 0 });
  });

  it.each([
    "",
    "not json",
    "[]",
    "null",
    '{"type":"partial"}',
    '{"type":"partial","text":3}',
    '{"type":"level","level":"loud"}',
    '{"type":"error","kind":"weird","message":"x"}',
    '{"type":"unknown"}',
  ])("ignores a malformed line %j", (line) => {
    expect(parseHelperLine(line)).toBeNull();
  });
});

describe("holdModifiers (096): the voice accelerator's modifiers, as the helper's --hold names them", () => {
  it.each([
    ["Control+Alt+V", ["control", "option"]],
    ["Ctrl+Option+Shift+K", ["control", "option", "shift"]],
    ["CommandOrControl+Shift+V", ["shift", "command"]],
    ["CmdOrCtrl+Alt+Space", ["option", "command"]],
    ["Cmd+V", ["command"]],
    ["Super+Alt+V", ["option", "command"]],
    ["Meta+V", ["command"]],
    ["alt+control+v", ["control", "option"]],
    ["Control+Ctrl+V", ["control"]],
  ])("%s → %j (fixed order: control, option, shift, command; no repeats)", (accelerator, names) => {
    expect(holdModifiers(accelerator)).toEqual(names);
  });

  it.each(["F13", "V", "", "Space"])("an accelerator with no modifier (%j) has nothing to hold: []", (accelerator) => {
    expect(holdModifiers(accelerator)).toEqual([]);
  });
});

describe("holdEscape (096 review 1): Esc as it arrives while the voice keys are held", () => {
  it.each([
    [["control", "option"], "Control+Alt+Escape"],
    [["control", "option", "shift"], "Control+Alt+Shift+Escape"],
    [["shift", "command"], "Shift+Command+Escape"],
    [["command"], "Command+Escape"],
  ])("%j → %s", (keys, accelerator) => {
    expect(holdEscape(keys)).toBe(accelerator);
  });

  it("nothing held → null (the bare Escape is enough)", () => {
    expect(holdEscape([])).toBeNull();
  });
});

describe("voice (hold to talk, 096)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holding the voice key shows the window and spawns the helper watching ⌃ and ⌥ (--hold control,option), with Esc held", () => {
    const t = setup();
    t.voice.press("key");
    expect(t.showWindow).toHaveBeenCalledTimes(1);
    expect(t.spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = t.spawn.mock.calls[0];
    expect(file).toBe("/app/native/snapsolve-speech");
    expect(args).toEqual(["--hold", "control,option"]);
    expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin" } });
    expect(t.last()).toEqual(listening(""));
    expect(t.voice.status()).toBe("listening");
    expect(t.shortcut.registered.has(ESCAPE)).toBe(true);
  });

  it("holding a mic button spawns the helper without the key watch (the button's own release ends it)", () => {
    const t = setup({ helper: { path: "/electron", prefixArgs: ["/fixtures/fake-speech.mjs"] } });
    t.voice.press("button");
    expect(t.spawn.mock.calls[0][0]).toBe("/electron");
    expect(t.spawn.mock.calls[0][1]).toEqual(["/fixtures/fake-speech.mjs"]);
    expect(t.last()).toEqual(listening(""));
    t.voice.cancel();
    // The key watch goes after the helper's own prefix arguments.
    t.voice.press("key");
    expect(t.spawn.mock.calls[1][1]).toEqual(["/fixtures/fake-speech.mjs", "--hold", "control,option"]);
  });

  it("partial and level lines update the listening state, also when a line arrives in pieces", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().stdout.write('{"type":"level","lev');
    t.child().stdout.write('el":0.4}\n{"type":"partial","text":"why the"}\n');
    await flush();
    expect(t.last()).toEqual(listening("why the", 0.4));
    t.child().line("garbage");
    t.child().line({ type: "partial", text: "why the product" });
    await flush();
    expect(t.last()).toEqual(listening("why the product", 0.4));
  });

  it("letting go of the keys sends: the helper's released line → SIGINT, the final text goes to send once", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "ready" });
    t.child().line({ type: "partial", text: "why the product" });
    await flush();
    t.tick(HELD_MS);
    t.child().line({ type: "released" });
    await flush();
    expect(t.child().signals).toEqual(["SIGINT"]);
    expect(t.last()).toEqual({ state: "stopping", text: "why the product", key: "⌃⌥V" });
    t.child().line({ type: "final", text: QUESTION });
    t.child().exit(0);
    await flush();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith(QUESTION);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.onFailed).not.toHaveBeenCalled();
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    // Idle again: the next hold starts a new dictation.
    t.voice.press("key");
    expect(t.spawn).toHaveBeenCalledTimes(2);
  });

  it("the key pressed again while held (auto-repeat) or while the text is on its way is ignored: one helper, no signal", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "ready" });
    await flush();
    t.tick(HELD_MS);
    t.voice.press("key");
    t.voice.press("key");
    t.voice.press("button");
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.child().signals).toEqual([]);
    expect(t.voice.status()).toBe("listening");
    t.child().line({ type: "released" });
    await flush();
    t.voice.press("key");
    t.voice.release("key");
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.child().signals).toEqual(["SIGINT"]);
    expect(t.voice.status()).toBe("stopping");
  });

  it("a held mic button sends when let go; a release from the other source, or a released line, does not end it", async () => {
    const t = setup();
    t.voice.press("button");
    t.child().line({ type: "ready" });
    await flush();
    t.tick(HELD_MS);
    t.voice.release("key");
    t.child().line({ type: "released" });
    await flush();
    expect(t.child().signals).toEqual([]);
    expect(t.voice.status()).toBe("listening");
    t.voice.release("button");
    expect(t.child().signals).toEqual(["SIGINT"]);
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
  });

  it("the keys' release does not end a button's dictation, and the button's release does not end the keys'", async () => {
    const t = setup();
    t.voice.press("key");
    t.tick(HELD_MS);
    t.voice.release("button");
    expect(t.voice.status()).toBe("listening");
    t.child().line({ type: "released" });
    await flush();
    expect(t.voice.status()).toBe("stopping");
  });

  it("let go before the helper is ready: waits for its ready line, then SIGINT (a SIGINT before would kill it)", async () => {
    const t = setup();
    t.voice.press("button");
    t.tick(HELD_MS);
    t.voice.release("button");
    expect(t.child().signals).toEqual([]);
    expect(t.last()).toEqual({ state: "stopping", text: "", key: "⌃⌥V" });
    t.child().line({ type: "ready" });
    await flush();
    expect(t.child().signals).toEqual(["SIGINT"]);
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
  });

  it(`a hold shorter than ${VOICE_MIN_HOLD_MS} ms is a tap: cancelled (SIGTERM), nothing sent, a note says to hold`, async () => {
    expect(VOICE_MIN_HOLD_MS).toBe(300);
    expect(VOICE_HOLD_NOTE).toBe("Hold to talk, let go to send.");
    for (const source of ["key", "button"] as const) {
      const t = setup();
      t.voice.press(source);
      t.child().line({ type: "ready" });
      await flush();
      t.tick(VOICE_MIN_HOLD_MS - 1);
      if (source === "key") t.child().line({ type: "released" });
      else t.voice.release(source);
      await flush();
      expect(t.child().signals).toEqual(["SIGTERM"]);
      expect(t.last()).toEqual({ state: "idle", note: VOICE_HOLD_NOTE });
      expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
      t.child().line({ type: "final", text: QUESTION });
      t.child().exit(0);
      await flush();
      expect(t.send).not.toHaveBeenCalled();
      expect(t.onFailed).not.toHaveBeenCalled();
    }
  });

  it(`a hold of exactly ${VOICE_MIN_HOLD_MS} ms counts: it sends`, async () => {
    const t = setup();
    t.voice.press("button");
    t.child().line({ type: "ready" });
    await flush();
    t.tick(VOICE_MIN_HOLD_MS);
    t.voice.release("button");
    expect(t.child().signals).toEqual(["SIGINT"]);
  });

  it("Esc pressed while ⌃⌥ are still held arrives as ⌃⌥Esc: that is held too during a key hold, cancels, and both are released after", async () => {
    const t = setup();
    t.voice.press("key");
    expect(t.shortcut.registered.has(ESCAPE)).toBe(true);
    expect(t.shortcut.registered.has("Control+Alt+Escape")).toBe(true);
    t.child().line({ type: "ready" });
    await flush();
    t.tick(HELD_MS);
    t.shortcut.press("Control+Alt+Escape");
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    expect(t.shortcut.registered.has("Control+Alt+Escape")).toBe(false);
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it("both Escapes are released when a key hold ends by sending too", async () => {
    const t = setup();
    await t.holdKeyAndLetGo();
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
    expect([...t.shortcut.registered.keys()]).toEqual([]);
    expect(t.shortcut.unregister.mock.calls.map((c) => c[0]).sort()).toEqual(["Control+Alt+Escape", ESCAPE].sort());
  });

  it("a mic button's dictation holds only the bare Escape (no modifier is down); so does a voice key with nothing to watch", () => {
    const button = setup();
    button.voice.press("button");
    expect([...button.shortcut.registered.keys()]).toEqual([ESCAPE]);
    const plain = setup({ holdKeys: [] });
    plain.voice.press("key");
    expect([...plain.shortcut.registered.keys()]).toEqual([ESCAPE]);
  });

  it("a ⌃⌥Esc taken by another app still lets the key hold run (logged); only what was ours is unregistered", async () => {
    const t = setup();
    t.shortcut.registered.set("Control+Alt+Escape", () => undefined);
    t.voice.press("key");
    expect(t.voice.status()).toBe("listening");
    expect(t.logLines.some((l) => l[0] === "voice.escapeTaken")).toBe(true);
    t.voice.cancel();
    expect(t.shortcut.unregister.mock.calls.map((c) => c[0])).toEqual([ESCAPE]);
    expect(t.shortcut.registered.has("Control+Alt+Escape")).toBe(true);
  });

  it("a press while the text is on its way is logged as ignored (063's voice.pressIgnored)", async () => {
    const t = setup();
    t.holdButtonAndLetGo();
    expect(t.voice.status()).toBe("stopping");
    t.voice.press("button");
    expect(t.logLines.filter((l) => l[0] === "voice.pressIgnored")).toHaveLength(1);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it("Esc while held cancels: nothing sent, Esc released; a later release or released line does nothing", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "partial", text: "why" });
    await flush();
    t.tick(HELD_MS);
    t.shortcut.press(ESCAPE);
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    expect(t.shortcut.unregister).toHaveBeenCalledWith(ESCAPE);
    const seen = t.states.length;
    t.child().line({ type: "released" });
    await flush();
    t.voice.release("key");
    t.voice.release("button");
    t.child().line({ type: "final", text: QUESTION });
    t.child().exit(0);
    await flush();
    expect(t.states.length).toBe(seen);
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.onFailed).not.toHaveBeenCalled();
  });

  it(`a release that never comes: listening ends at ${VOICE_MAX_HOLD_MS / 1000} s with stop and send, logged`, async () => {
    vi.useFakeTimers();
    expect(VOICE_MAX_HOLD_MS).toBe(120_000);
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(VOICE_MAX_HOLD_MS - 1);
    expect(t.child().signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.child().signals).toEqual(["SIGINT"]);
    expect(t.voice.status()).toBe("stopping");
    expect(t.logLines.some((l) => l[0] === "voice.holdCapped")).toBe(true);
    t.child().line({ type: "final", text: QUESTION });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.send).toHaveBeenCalledWith(QUESTION);
  });

  it("the hold cap does not fire after the dictation ended", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.voice.press("button");
    t.tick(HELD_MS);
    t.voice.cancel();
    vi.advanceTimersByTime(VOICE_MAX_HOLD_MS);
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.logLines.some((l) => l[0] === "voice.holdCapped")).toBe(false);
  });

  it("a voice key with no modifier to watch (holdKeys []) works as before 096: press again to send", async () => {
    const t = setup({ holdKeys: [] });
    t.voice.press("key");
    expect(t.spawn.mock.calls[0][1]).toEqual([]);
    expect(t.last()).toEqual(listening("", 0, false));
    t.child().line({ type: "ready" });
    await flush();
    t.tick(HELD_MS);
    t.voice.release("key");
    expect(t.child().signals).toEqual([]);
    t.voice.press("key");
    expect(t.child().signals).toEqual(["SIGINT"]);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it("a helper that never gets ready after the release is killed at the stop timeout", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.holdButtonAndLetGo();
    vi.advanceTimersByTime(VOICE_STOP_TIMEOUT_MS);
    expect(t.child().signals).toEqual(["SIGKILL"]);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.onFailed).toHaveBeenCalledTimes(1);
  });

  it("a press while the current thread is thinking or answering is ignored: nothing spawned, a note says to wait", () => {
    for (const source of ["key", "button"] as const) {
      const t = setup({ answering: true });
      t.voice.press(source);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.showWindow).not.toHaveBeenCalled();
      expect(t.shortcut.register).not.toHaveBeenCalled();
      expect(VOICE_BUSY_NOTE).toBe("Wait for the answer, then ask.");
      expect(t.last()).toEqual({ state: "idle", note: VOICE_BUSY_NOTE });
      expect(t.voice.status()).toBe("idle");
      // Letting go of that press does nothing.
      t.voice.release(source);
      expect(t.states.length).toBe(1);
    }
  });

  it("an answer that starts while listening does not block the release: it still sends", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "ready" });
    await flush();
    t.isAnswering.mockReturnValue(true);
    t.tick(HELD_MS);
    t.child().line({ type: "released" });
    await flush();
    expect(t.child().signals).toEqual(["SIGINT"]);
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
  });

  it("the final text is trimmed before it is sent", async () => {
    const t = setup();
    await t.holdKeyAndLetGo();
    t.child().line({ type: "final", text: `  ${QUESTION}\n` });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
  });

  it("a helper still running after its final line is stopped (no orphan process)", async () => {
    const t = setup();
    t.voice.press("button");
    t.child().line({ type: "ready" });
    await flush();
    t.tick(HELD_MS);
    t.voice.release("button");
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.child().signals).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("Esc also cancels while the helper is finishing", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "ready" });
    await flush();
    t.tick(HELD_MS);
    t.child().line({ type: "released" });
    await flush();
    t.shortcut.press(ESCAPE);
    expect(t.child().signals).toEqual(["SIGINT", "SIGTERM"]);
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
  });

  it("helper is stopped on window hide: cancel() kills it and sends nothing; cancel() when idle does nothing", async () => {
    const t = setup();
    t.voice.cancel();
    expect(t.states).toEqual([]);
    t.voice.press("key");
    t.voice.cancel();
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.last()).toEqual({ state: "idle" });
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it("release when idle does nothing", () => {
    const t = setup();
    t.voice.release("key");
    t.voice.release("button");
    expect(t.states).toEqual([]);
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it("empty transcript sends nothing and shows a note", async () => {
    const t = setup();
    await t.holdKeyAndLetGo();
    t.child().line({ type: "final", text: "   " });
    t.child().exit(0);
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(VOICE_EMPTY_NOTE).toBe("Didn't catch that.");
    expect(t.last()).toEqual({ state: "idle", note: VOICE_EMPTY_NOTE });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
  });

  it.each([
    ["micDenied", "microphone"],
    ["speechDenied", "speechRecognition"],
  ] as const)("mic denied shows a permission card: a %s line → onDenied(%s), nothing sent, Esc released", async (kind, denial) => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "error", kind, message: "denied" });
    t.child().exit(1);
    await flush();
    expect(t.onDenied).toHaveBeenCalledTimes(1);
    expect(t.onDenied).toHaveBeenCalledWith(denial);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
  });

  it("a helper error of kind failed → the error card, nothing sent", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "error", kind: "failed", message: "audio engine" });
    t.child().exit(1);
    await flush();
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.send).not.toHaveBeenCalled();
  });

  it("an unavailable recognizer → a note saying voice is not available on this Mac", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().line({ type: "error", kind: "unavailable", message: "locale" });
    t.child().exit(1);
    await flush();
    expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceUnavailable") });
    expect(t.onDenied).not.toHaveBeenCalled();
  });

  it("helper crash → an error card, not a hang: exit without a final line, while listening or stopping", async () => {
    for (const stopFirst of [false, true]) {
      const t = setup();
      t.voice.press("button");
      if (stopFirst) {
        t.tick(HELD_MS);
        t.voice.release("button");
      }
      t.child().exit(null, "SIGSEGV");
      await flush();
      expect(t.last()).toEqual({ state: "idle" });
      expect(t.onFailed).toHaveBeenCalledTimes(1);
      expect(t.send).not.toHaveBeenCalled();
      expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    }
  });

  it("a helper that cannot start (spawn error event or a throw) → the error card, Esc released", async () => {
    const t = setup();
    t.voice.press("key");
    t.child().emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await flush();
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);

    const thrown = setup({ spawnThrows: new Error("EACCES") });
    thrown.voice.press("key");
    expect(thrown.last()).toEqual({ state: "idle" });
    expect(thrown.onFailed).toHaveBeenCalledTimes(1);
    expect(thrown.shortcut.registered.has(ESCAPE)).toBe(false);
    expect(thrown.voice.status()).toBe("idle");
  });

  it("a helper that never answers the stop is killed after the stop timeout, with the error card", async () => {
    const t = setup();
    t.voice.press("button");
    t.child().line({ type: "ready" });
    await flush();
    vi.useFakeTimers();
    t.tick(HELD_MS);
    t.voice.release("button");
    vi.advanceTimersByTime(VOICE_STOP_TIMEOUT_MS - 1);
    expect(t.child().signals).toEqual(["SIGINT"]);
    vi.advanceTimersByTime(1);
    expect(t.child().signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(t.send).not.toHaveBeenCalled();
  });

  it("no helper (not macOS, or not built) → a note, nothing spawned, no Esc shortcut", () => {
    const t = setup({ helper: null });
    t.voice.press("key");
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceUnavailable") });
    expect(t.shortcut.register).not.toHaveBeenCalled();
  });

  it("an Esc taken by another app still lets the dictation run (logged), and nothing is unregistered that is not ours", async () => {
    const t = setup();
    t.shortcut.registered.set(ESCAPE, () => undefined);
    t.voice.press("button");
    expect(t.voice.status()).toBe("listening");
    t.tick(HELD_MS);
    t.voice.release("button");
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
    expect(t.shortcut.unregister).not.toHaveBeenCalled();
  });

  it("a send that fails is logged, voice is idle again", async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error("no thread"));
    await t.holdKeyAndLetGo();
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    await flush();
    expect(t.voice.status()).toBe("idle");
    expect(t.logText()).toContain("voice.sendFailed");
  });

  it("the transcript is never logged (ARCHITECTURE Do NOT), not even partial text or a failed send", async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error("no thread"));
    t.voice.press("key");
    t.child().line({ type: "partial", text: "secret partial words" });
    t.child().stderr.write("helper noise\n");
    await flush();
    t.tick(HELD_MS);
    t.child().line({ type: "released" });
    await flush();
    t.child().line({ type: "final", text: "secret final words" });
    t.child().exit(0);
    await flush();
    await flush();
    expect(t.logText()).not.toContain("secret");
  });
});

describe("voice with fake timers off", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("a second dictation's output never reaches the first one's state (each run is its own)", async () => {
    const t = setup();
    t.voice.press("key");
    const first = t.child();
    t.voice.cancel();
    t.voice.press("key");
    const second = t.child();
    expect(second).not.toBe(first);
    first.line({ type: "partial", text: "old" });
    first.line({ type: "released" });
    second.line({ type: "partial", text: "new" });
    await flush();
    expect(t.last()).toEqual(listening("new"));
    first.exit(0);
    await flush();
    expect(t.voice.status()).toBe("listening");
  });
});

describe("resolveSpeechHelper (063)", () => {
  let dir: string;
  const helperFile = () => path.join(dir, "native", "snapsolve-speech");
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "snapsolve-voice-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  async function writeHelper(mode: number) {
    await mkdir(path.join(dir, "native"), { recursive: true });
    await writeFile(helperFile(), "mach-o");
    await chmod(helperFile(), mode);
  }

  it("macOS: native/snapsolve-speech beside main.js, run directly", async () => {
    await writeHelper(0o755);
    expect(await resolveSpeechHelper({ platform: "darwin", appDir: dir, execPath: "/electron" })).toEqual({ path: helperFile(), prefixArgs: [] });
  });

  it("a helper that lost its executable bit (copied by a plugin cache) is made executable again", async () => {
    await writeHelper(0o644);
    expect(await resolveSpeechHelper({ platform: "darwin", appDir: dir, execPath: "/electron" })).toEqual({ path: helperFile(), prefixArgs: [] });
    expect((await stat(helperFile())).mode & 0o111).toBe(0o111);
  });

  it("no helper built (no swiftc) → null, logged", async () => {
    const warn = vi.fn();
    expect(await resolveSpeechHelper({ platform: "darwin", appDir: dir, execPath: "/electron", log: { warn } })).toBeNull();
    expect(warn).toHaveBeenCalledWith("voice.helperMissing", expect.anything());
  });

  it("not macOS → null, even with a helper file", async () => {
    await writeHelper(0o755);
    expect(await resolveSpeechHelper({ platform: "win32", appDir: dir, execPath: "/electron" })).toBeNull();
  });

  it("test mode: the fake helper script, run by Electron as node", async () => {
    expect(await resolveSpeechHelper({ platform: "linux", appDir: dir, execPath: "/electron", testHelper: "/fixtures/fake-speech.mjs" })).toEqual({
      path: "/electron",
      prefixArgs: ["/fixtures/fake-speech.mjs"],
    });
  });
});
