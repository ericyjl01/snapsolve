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
  parseHelperLine,
  resolveSpeechHelper,
  VOICE_EMPTY_NOTE,
  VOICE_STOP_TIMEOUT_MS,
  type VoiceDeps,
} from "../../src/main/voice";
import { userMessage } from "../../src/shared/errors";
import type { VoiceState } from "../../src/shared/types";

const QUESTION = "why the product rule?";

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
  return { log, text: () => JSON.stringify(lines) };
}

function setup(options: { helper?: VoiceDeps["helper"]; spawnThrows?: Error } = {}) {
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
  const showWindow = vi.fn();
  const recorded = recordingLog();
  const deps: VoiceDeps = {
    helper: options.helper === undefined ? { path: "/app/native/snapsolve-speech", prefixArgs: [] } : options.helper,
    spawn,
    env: { PATH: "/usr/bin" },
    globalShortcut: shortcut,
    keyLabel: "⌃⌥V",
    onState: (s) => void states.push(s),
    send,
    onDenied,
    showWindow,
    log: recorded.log,
  };
  const voice = createVoice(deps);
  return {
    voice,
    deps,
    spawn,
    shortcut,
    states,
    send,
    onDenied,
    showWindow,
    logText: recorded.text,
    child: () => children.at(-1)!,
    children,
    last: () => states.at(-1),
  };
}

/** Lets stdout lines, exit and close run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

describe("parseHelperLine (helper output parsing)", () => {
  it("reads ready, level, partial, final and error lines", () => {
    expect(parseHelperLine('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseHelperLine('{"type":"level","level":0.5}')).toEqual({ type: "level", level: 0.5 });
    expect(parseHelperLine('{"type":"partial","text":"why the"}')).toEqual({ type: "partial", text: "why the" });
    expect(parseHelperLine('{"type":"final","text":"why"}')).toEqual({ type: "final", text: "why" });
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

describe("voice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first press shows the window, spawns the helper with piped stdio and listens with the Esc shortcut held", () => {
    const t = setup();
    t.voice.toggle();
    expect(t.showWindow).toHaveBeenCalledTimes(1);
    expect(t.spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = t.spawn.mock.calls[0];
    expect(file).toBe("/app/native/snapsolve-speech");
    expect(args).toEqual([]);
    expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin" } });
    expect(t.last()).toEqual({ state: "listening", text: "", level: 0, key: "⌃⌥V" });
    expect(t.voice.status()).toBe("listening");
    expect(t.shortcut.registered.has(ESCAPE)).toBe(true);
  });

  it("partial and level lines update the listening state, also when a line arrives in pieces", async () => {
    const t = setup();
    t.voice.toggle();
    t.child().stdout.write('{"type":"level","lev');
    t.child().stdout.write('el":0.4}\n{"type":"partial","text":"why the"}\n');
    await flush();
    expect(t.last()).toEqual({ state: "listening", text: "why the", level: 0.4, key: "⌃⌥V" });
    t.child().line("garbage");
    t.child().line({ type: "partial", text: "why the product" });
    await flush();
    expect(t.last()).toEqual({ state: "listening", text: "why the product", level: 0.4, key: "⌃⌥V" });
  });

  it("second Ctrl+Option+V sends: stop is SIGINT, a press while it finishes is ignored, the final text goes to send once", async () => {
    const t = setup();
    t.voice.toggle();
    t.child().line({ type: "partial", text: "why the product" });
    await flush();
    t.voice.toggle();
    expect(t.child().signals).toEqual(["SIGINT"]);
    expect(t.last()).toEqual({ state: "stopping", text: "why the product", key: "⌃⌥V" });
    // While the helper finishes the transcript (and while the answer is being worked on) another press does nothing.
    t.voice.toggle();
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.child().signals).toEqual(["SIGINT"]);
    t.child().line({ type: "final", text: QUESTION });
    t.child().exit(0);
    await flush();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith(QUESTION);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    // Idle again: the next press starts a new dictation.
    t.voice.toggle();
    expect(t.spawn).toHaveBeenCalledTimes(2);
  });

  it("the final text is trimmed before it is sent", async () => {
    const t = setup();
    t.voice.toggle();
    t.voice.toggle();
    t.child().line({ type: "final", text: `  ${QUESTION}\n` });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
  });

  it("a helper still running after its final line is stopped (no orphan process)", async () => {
    const t = setup();
    t.voice.toggle();
    t.voice.toggle();
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.child().signals).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("Esc cancels: the helper is killed, nothing is sent, a later final is ignored and Esc is unregistered", async () => {
    const t = setup();
    t.voice.toggle();
    t.child().line({ type: "partial", text: "why" });
    await flush();
    t.shortcut.press(ESCAPE);
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    expect(t.shortcut.unregister).toHaveBeenCalledWith(ESCAPE);
    t.child().line({ type: "final", text: QUESTION });
    t.child().exit(0);
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ state: "idle" });
  });

  it("Esc also cancels while the helper is finishing", async () => {
    const t = setup();
    t.voice.toggle();
    t.voice.toggle();
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
    t.voice.toggle();
    t.voice.cancel();
    expect(t.child().signals).toEqual(["SIGTERM"]);
    expect(t.last()).toEqual({ state: "idle" });
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it("empty transcript sends nothing and shows a note", async () => {
    const t = setup();
    t.voice.toggle();
    t.voice.toggle();
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
    t.voice.toggle();
    t.child().line({ type: "error", kind, message: "denied" });
    t.child().exit(1);
    await flush();
    expect(t.onDenied).toHaveBeenCalledTimes(1);
    expect(t.onDenied).toHaveBeenCalledWith(denial);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ state: "idle" });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
  });

  it("an unavailable recognizer → a note saying voice is not available on this Mac", async () => {
    const t = setup();
    t.voice.toggle();
    t.child().line({ type: "error", kind: "unavailable", message: "locale" });
    t.child().exit(1);
    await flush();
    expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceUnavailable") });
    expect(t.onDenied).not.toHaveBeenCalled();
  });

  it("helper crash → an error note, not a hang: exit without a final line, while listening or stopping", async () => {
    for (const stopFirst of [false, true]) {
      const t = setup();
      t.voice.toggle();
      if (stopFirst) t.voice.toggle();
      t.child().exit(null, "SIGSEGV");
      await flush();
      expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceFailed") });
      expect(t.send).not.toHaveBeenCalled();
      expect(t.shortcut.registered.has(ESCAPE)).toBe(false);
    }
  });

  it("a helper that cannot start (spawn error event or a throw) → the error note, Esc released", async () => {
    const t = setup();
    t.voice.toggle();
    t.child().emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await flush();
    expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceFailed") });
    expect(t.shortcut.registered.has(ESCAPE)).toBe(false);

    const thrown = setup({ spawnThrows: new Error("EACCES") });
    thrown.voice.toggle();
    expect(thrown.last()).toEqual({ state: "idle", note: userMessage("voiceFailed") });
    expect(thrown.shortcut.registered.has(ESCAPE)).toBe(false);
    expect(thrown.voice.status()).toBe("idle");
  });

  it("a helper that never answers the stop is killed after the stop timeout, with the error note", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.voice.toggle();
    t.voice.toggle();
    vi.advanceTimersByTime(VOICE_STOP_TIMEOUT_MS - 1);
    expect(t.child().signals).toEqual(["SIGINT"]);
    vi.advanceTimersByTime(1);
    expect(t.child().signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceFailed") });
    expect(t.send).not.toHaveBeenCalled();
  });

  it("no helper (not macOS, or not built) → a note, nothing spawned, no Esc shortcut", () => {
    const t = setup({ helper: null });
    t.voice.toggle();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ state: "idle", note: userMessage("voiceUnavailable") });
    expect(t.shortcut.register).not.toHaveBeenCalled();
  });

  it("an Esc taken by another app still lets the dictation run (logged), and nothing is unregistered that is not ours", async () => {
    const t = setup();
    t.shortcut.registered.set(ESCAPE, () => undefined);
    t.voice.toggle();
    expect(t.voice.status()).toBe("listening");
    t.voice.toggle();
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    expect(t.send).toHaveBeenCalledWith(QUESTION);
    expect(t.shortcut.unregister).not.toHaveBeenCalled();
  });

  it("a send that fails is logged, voice is idle again", async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error("no thread"));
    t.voice.toggle();
    t.voice.toggle();
    t.child().line({ type: "final", text: QUESTION });
    await flush();
    await flush();
    expect(t.voice.status()).toBe("idle");
    expect(t.logText()).toContain("voice.sendFailed");
  });

  it("the transcript is never logged (ARCHITECTURE Do NOT), not even partial text or a failed send", async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error("no thread"));
    t.voice.toggle();
    t.child().line({ type: "partial", text: "secret partial words" });
    t.child().stderr.write("helper noise\n");
    await flush();
    t.voice.toggle();
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
    t.voice.toggle();
    const first = t.child();
    t.voice.cancel();
    t.voice.toggle();
    const second = t.child();
    expect(second).not.toBe(first);
    first.line({ type: "partial", text: "old" });
    second.line({ type: "partial", text: "new" });
    await flush();
    expect(t.last()).toEqual({ state: "listening", text: "new", level: 0, key: "⌃⌥V" });
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
