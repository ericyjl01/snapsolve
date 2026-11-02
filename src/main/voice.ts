// Voice follow-up (task 063, SPEC Amendment 11; hold to talk, task 096, Amendment 27): holding the voice hotkey (or a
// mic button) starts the speech helper (native/speech, macOS on-device recognition), its live transcript shows in the
// listening bar, and letting go stops it and sends the final text as a follow-up. Electron's globalShortcut has no
// key-up, so for the hotkey the helper itself watches the hotkey's modifiers (`--hold control,option`) and prints
// "released" once one is up; a mic button's release comes from the renderer. A hold under VOICE_MIN_HOLD_MS is a tap:
// cancelled with a note. Esc (a global shortcut held only while listening) or hiding the window cancels. The helper
// talks JSON lines on stdout; SIGINT means stop and send (sent only after its "ready" line), SIGTERM means gone. The
// transcript is never logged.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { userMessage } from "../shared/errors";
import type { VoiceDenial, VoiceState } from "../shared/types";
import type { Logger } from "./log";

/** The temporary cancel key. */
export const ESCAPE = "Escape";
/** How long the helper may take to finish the transcript after the stop. */
export const VOICE_STOP_TIMEOUT_MS = 15_000;
export const VOICE_EMPTY_NOTE = "Didn't catch that.";
/** A press while the current thread is still thinking or answering is ignored (063). */
export const VOICE_BUSY_NOTE = "Wait for the answer, then ask.";
/** A hold shorter than this is a tap: cancelled, nothing sent (096). */
export const VOICE_MIN_HOLD_MS = 300;
/** A tap's note. */
export const VOICE_HOLD_NOTE = "Hold to talk, let go to send.";
/** A hold whose release never arrives (a lost key-up or pointer-up) stops and sends here (096). */
export const VOICE_MAX_HOLD_MS = 120_000;
/** The helper beside main.js (dist/ in dev, app/ when released). */
export const SPEECH_HELPER = path.join("native", "snapsolve-speech");

export type HelperMessage =
  | { type: "ready" }
  | { type: "level"; level: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  /** The hotkey's watched modifiers came up (096): the hold is over. */
  | { type: "released" }
  | { type: "error"; kind: "micDenied" | "speechDenied" | "unavailable" | "failed"; message: string };

const ERROR_KINDS = new Set(["micDenied", "speechDenied", "unavailable", "failed"]);

/** One stdout line, or null for anything that is not a well-formed message (ignored). */
export function parseHelperLine(line: string): HelperMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "released":
      return { type: "released" };
    case "level":
      return typeof m.level === "number" && Number.isFinite(m.level) ? { type: "level", level: Math.min(Math.max(m.level, 0), 1) } : null;
    case "partial":
    case "final":
      return typeof m.text === "string" ? { type: m.type, text: m.text } : null;
    case "error":
      return typeof m.kind === "string" && ERROR_KINDS.has(m.kind) && typeof m.message === "string"
        ? { type: "error", kind: m.kind as Extract<HelperMessage, { type: "error" }>["kind"], message: m.message }
        : null;
    default:
      return null;
  }
}

const MODIFIERS: Readonly<Record<string, string>> = {
  control: "control",
  ctrl: "control",
  alt: "option",
  option: "option",
  shift: "shift",
  command: "command",
  cmd: "command",
  commandorcontrol: "command",
  cmdorctrl: "command",
  super: "command",
  meta: "command",
};
const MODIFIER_ORDER = ["control", "option", "shift", "command"];

/**
 * The modifiers of the voice accelerator (macOS: CommandOrControl is Command) as the helper's `--hold` names them, in a
 * fixed order (096). None ("F13") → []: nothing to watch, so that key is pressed again to send, as before 096.
 */
export function holdModifiers(accelerator: string): string[] {
  const held = new Set(
    accelerator
      .split("+")
      .map((token) => MODIFIERS[token.trim().toLowerCase()])
      .filter((name): name is string => name !== undefined),
  );
  return MODIFIER_ORDER.filter((name) => held.has(name));
}

/** Who holds the dictation: the voice hotkey, or a mic button (096). Only its own release ends it. */
export type VoiceSource = "key" | "button";

export interface SpeechHelper {
  path: string;
  prefixArgs: string[];
}

/**
 * The helper to run, or null when there is none: macOS only, `native/snapsolve-speech` beside main.js, made
 * executable again if a copy dropped the bit. In test mode `testHelper` is a node script Electron runs as node.
 */
export async function resolveSpeechHelper(options: {
  platform: NodeJS.Platform;
  appDir: string;
  execPath: string;
  testHelper?: string;
  log?: Pick<Logger, "warn">;
}): Promise<SpeechHelper | null> {
  if (options.testHelper) return { path: options.execPath, prefixArgs: [options.testHelper] };
  if (options.platform !== "darwin") return null;
  const file = path.join(options.appDir, SPEECH_HELPER);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTFILE" });
    if ((info.mode & 0o111) !== 0o111) await chmod(file, info.mode | 0o755);
    return { path: file, prefixArgs: [] };
  } catch (e) {
    options.log?.warn("voice.helperMissing", { file, error: e });
    return null;
  }
}

export interface VoiceDeps {
  /** null: voice is not available here (not macOS, or the helper was not built). */
  helper: SpeechHelper | null;
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  env: Readonly<Record<string, string | undefined>>;
  /** Electron's `globalShortcut`, for the temporary Esc. */
  globalShortcut: { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void };
  /** The voice key as the listening bar names it ("⌃⌥V"). */
  keyLabel: string;
  /** `holdModifiers(config.hotkeys.voice)`: what the helper watches while the hotkey is held (096). */
  holdKeys: readonly string[];
  /** Every state change, for the renderer. */
  onState: (state: VoiceState) => void;
  /** The final transcript (trimmed, non-empty): where a typed question would go (app.onVoice). */
  send: (text: string) => Promise<unknown>;
  /** The helper reported a refused permission: the panel's permission card. */
  onDenied: (denial: VoiceDenial) => void;
  /** The helper crashed, could not start, failed or never finished: the panel's voice error card. */
  onFailed: () => void;
  /** The thread a question would join is thinking or answering (app.isAnswering): a press then is ignored. */
  isAnswering: () => boolean;
  /** Shows the window without focus (panel.open). */
  showWindow: () => void;
  log: Pick<Logger, "info" | "warn" | "error">;
  stopTimeoutMs?: number;
  /** For a hold's length; default Date.now. */
  now?: () => number;
}

export interface Voice {
  /**
   * The voice hotkey or a mic button went down: idle → listening (ignored while the current thread is thinking or
   * answering). While a dictation runs a press is ignored (the key's auto-repeat, the other source), except the key
   * with no modifier to watch, which then stops and sends as before 096.
   */
  press(source: VoiceSource): void;
  /**
   * That source came up (the helper's "released" line for the key): stop and send; a tap (under VOICE_MIN_HOLD_MS)
   * cancels with VOICE_HOLD_NOTE. Ignored when idle, finishing, or held by the other source.
   */
  release(source: VoiceSource): void;
  /** Esc, or the window hidden: stop without sending. Idle: nothing. */
  cancel(): void;
  status(): VoiceState["state"];
}

interface Run {
  child: ChildProcess;
  source: VoiceSource;
  /** Its source's release ends it (false: the key with no modifier to watch, pressed again instead). */
  hold: boolean;
  startedAt: number;
  text: string;
  level: number;
  stopping: boolean;
  /** The helper printed ready: its SIGINT handler is in place (a SIGINT before that would kill it). */
  ready: boolean;
  exited: boolean;
  escHeld: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  holdTimer?: ReturnType<typeof setTimeout>;
}

export function createVoice(deps: VoiceDeps): Voice {
  const { log } = deps;
  const stopTimeoutMs = deps.stopTimeoutMs ?? VOICE_STOP_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  let run: Run | null = null;

  function emit(state: VoiceState): void {
    deps.onState(state);
  }

  function show(r: Run): void {
    emit(
      r.stopping
        ? { state: "stopping", text: r.text, key: deps.keyLabel }
        : { state: "listening", text: r.text, level: r.level, key: deps.keyLabel, hold: r.hold },
    );
  }

  /** Leaves `r` for good: timers and Esc released; later output from its child is ignored. */
  function end(r: Run, state: VoiceState): void {
    if (run !== r) return;
    run = null;
    clearTimeout(r.stopTimer);
    clearTimeout(r.holdTimer);
    if (r.escHeld) {
      r.escHeld = false;
      try {
        deps.globalShortcut.unregister(ESCAPE);
      } catch (e) {
        log.warn("voice.escapeUnregisterFailed", { error: e });
      }
    }
    emit(state);
  }

  function kill(r: Run, signal: NodeJS.Signals): void {
    if (r.exited) return;
    try {
      r.child.kill(signal);
    } catch (e) {
      log.warn("voice.killFailed", { signal, error: e });
    }
  }

  function failed(r: Run, event: string, fields: Record<string, unknown>): void {
    if (run !== r) return;
    log.warn(event, fields);
    kill(r, "SIGTERM");
    end(r, { state: "idle" });
    deps.onFailed();
  }

  function onMessage(r: Run, message: HelperMessage): void {
    if (run !== r) return;
    switch (message.type) {
      case "ready":
        r.ready = true;
        log.info("voice.listening", {});
        // Let go before the helper was ready: the stop it was waiting for.
        if (r.stopping) kill(r, "SIGINT");
        return;
      case "released":
        // Only the hotkey's watch prints it; a mic button's dictation ends on the button's own release.
        if (r.source === "key") release("key");
        return;
      case "level":
        if (r.stopping) return;
        r.level = message.level;
        show(r);
        return;
      case "partial":
        r.text = message.text;
        show(r);
        return;
      case "final": {
        const text = message.text.trim();
        kill(r, "SIGTERM");
        if (!text) {
          end(r, { state: "idle", note: VOICE_EMPTY_NOTE });
          return;
        }
        end(r, { state: "idle" });
        log.info("voice.sent", { chars: text.length });
        void deps.send(text).catch((e: unknown) => log.warn("voice.sendFailed", { error: e }));
        return;
      }
      case "error":
        log.warn("voice.helperError", { kind: message.kind });
        if (message.kind === "micDenied" || message.kind === "speechDenied") {
          end(r, { state: "idle" });
          deps.onDenied(message.kind === "micDenied" ? "microphone" : "speechRecognition");
        } else if (message.kind === "unavailable") {
          end(r, { state: "idle", note: userMessage("voiceUnavailable") });
        } else {
          end(r, { state: "idle" });
          deps.onFailed();
        }
        return;
    }
  }

  function start(source: VoiceSource): void {
    const helper = deps.helper;
    if (!helper) {
      emit({ state: "idle", note: userMessage("voiceUnavailable") });
      return;
    }
    if (deps.isAnswering()) {
      log.info("voice.pressIgnored", { reason: "answering" });
      emit({ state: "idle", note: VOICE_BUSY_NOTE });
      return;
    }
    deps.showWindow();
    const watch = source === "key" && deps.holdKeys.length > 0 ? ["--hold", deps.holdKeys.join(",")] : [];
    let child: ChildProcess;
    try {
      child = deps.spawn(helper.path, [...helper.prefixArgs, ...watch], { env: { ...deps.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      log.warn("voice.spawnFailed", { error: e });
      emit({ state: "idle" });
      deps.onFailed();
      return;
    }
    const hold = source === "button" || watch.length > 0;
    const r: Run = { child, source, hold, startedAt: now(), text: "", level: 0, stopping: false, ready: false, exited: false, escHeld: false };
    run = r;
    if (hold) {
      r.holdTimer = setTimeout(() => {
        if (run !== r || r.stopping) return;
        log.warn("voice.holdCapped", { ms: VOICE_MAX_HOLD_MS, source });
        stop(r);
      }, VOICE_MAX_HOLD_MS);
    }
    try {
      r.escHeld = deps.globalShortcut.register(ESCAPE, () => cancel());
      if (!r.escHeld) log.warn("voice.escapeTaken", {});
    } catch (e) {
      log.warn("voice.escapeTaken", { error: e });
    }
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        const message = line ? parseHelperLine(line) : null;
        if (message) onMessage(r, message);
        newline = buffered.indexOf("\n");
      }
    });
    // stderr is drained, never logged: it could echo what was said.
    child.stderr?.resume();
    child.stdin?.on("error", () => undefined);
    child.on("error", (e: Error) => failed(r, "voice.helperFailed", { error: e }));
    child.on("exit", () => {
      r.exited = true;
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      r.exited = true;
      failed(r, "voice.helperExited", { code, signal });
    });
    show(r);
  }

  /** Stop and send: SIGINT once the helper is ready (else when it says so); the stop timeout runs from the stop. */
  function stop(r: Run): void {
    r.stopping = true;
    clearTimeout(r.holdTimer);
    if (r.ready) kill(r, "SIGINT");
    r.stopTimer = setTimeout(() => {
      if (run !== r) return;
      log.warn("voice.stopTimedOut", { ms: stopTimeoutMs });
      kill(r, "SIGKILL");
      end(r, { state: "idle" });
      deps.onFailed();
    }, stopTimeoutMs);
    show(r);
  }

  function cancel(): void {
    const r = run;
    if (!r) return;
    log.info("voice.cancelled", {});
    kill(r, "SIGTERM");
    end(r, { state: "idle" });
  }

  function release(source: VoiceSource): void {
    const r = run;
    if (!r || r.stopping || !r.hold || r.source !== source) return;
    const heldMs = now() - r.startedAt;
    if (heldMs < VOICE_MIN_HOLD_MS) {
      log.info("voice.tooShort", { ms: heldMs, source });
      kill(r, "SIGTERM");
      end(r, { state: "idle", note: VOICE_HOLD_NOTE });
      return;
    }
    stop(r);
  }

  return {
    press(source) {
      const r = run;
      if (!r) start(source);
      // No modifier to watch: the key works as a toggle (063). Anything else while a dictation runs is ignored.
      else if (source === "key" && r.source === "key" && !r.hold && !r.stopping) stop(r);
    },
    release,
    cancel,
    status: () => (run ? (run.stopping ? "stopping" : "listening") : "idle"),
  };
}
