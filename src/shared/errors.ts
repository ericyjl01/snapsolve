// Error kinds and the text the card shows for each (SPEC §7.1). Shared by main and renderer: no Node imports.
import type { Turn } from "./types";

export const ERROR_KINDS = [
  "claudeNotFound",
  "notLoggedIn",
  "apiKeyInUse",
  "usageLimit",
  "timeout",
  "resumeFailed",
  "screenRecordingDenied",
  "captureFailed",
  "hotkeyTaken",
  "dataDirUnavailable",
  "unsupportedPlatform",
  "threadNotFound",
  "internal",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

const MESSAGES: Record<ErrorKind, string> = {
  claudeNotFound: "Claude Code not found. Run /snapsolve install.",
  notLoggedIn: "Run `claude` once and log in.",
  apiKeyInUse: "Warning: billing to an API key.",
  usageLimit: "Usage limit reached.",
  timeout: "Timed out and stopped. Press Retry to try again.",
  resumeFailed: "Couldn't resume the earlier session; started a new one with this thread's history.",
  screenRecordingDenied: "snapsolve needs Screen Recording permission. Grant it in System Settings, then relaunch.",
  captureFailed: "Couldn't capture the screen. Press the hotkey to try again.",
  hotkeyTaken: "A snapsolve hotkey is taken by another app. Change it under hotkeys in config.json.",
  dataDirUnavailable: "snapsolve can't find or create its data folder.",
  unsupportedPlatform: "snapsolve runs only on Windows and macOS.",
  threadNotFound: "This thread no longer exists.",
  internal: "Something went wrong. Details are in the snapsolve log.",
};

/** SPEC §2.3: the card note on a thread an append past the screenshot limit started. */
export const CONTINUED_NOTE = "Continued from the previous thread (screenshot limit reached); its last answer was sent along.";

/** The note the card shows at `turn`: `CONTINUED_NOTE` for a seeded screenshot, else null. */
export function continuedNote(turn: Turn): string | null {
  return turn.role === "user" && turn.kind === "screenshot" && turn.seed !== undefined ? CONTINUED_NOTE : null;
}

/** The card text for `kind`; an unknown kind (e.g. from a stale renderer) gets the `internal` text. */
export function userMessage(kind: ErrorKind): string {
  return Object.hasOwn(MESSAGES, kind) ? MESSAGES[kind] : MESSAGES.internal;
}

/** What the macOS Screen Recording card shows (SPEC §7.1, Amendment 2) and the buttons it offers. */
export interface ScreenRecordingCard {
  message: string;
  actions: ("openSettings" | "relaunch")[];
}

/**
 * `prompted`: this capture just raised the system prompt, so granting there and relaunching is enough; otherwise the
 * grant was refused earlier and only System Settings can change it.
 */
export function screenRecordingCard(prompted: boolean): ScreenRecordingCard {
  return prompted
    ? { message: "Grant Screen Recording in the prompt, then click Relaunch.", actions: ["relaunch"] }
    : { message: MESSAGES.screenRecordingDenied, actions: ["openSettings", "relaunch"] };
}

/** The one error type the app throws or returns. `message` is for the log; the UI shows `userMessage(kind)`. */
export class SnapsolveError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message?: string, options?: { cause?: unknown }) {
    super(message ?? userMessage(kind), options);
    this.name = "SnapsolveError";
    this.kind = kind;
  }
}
