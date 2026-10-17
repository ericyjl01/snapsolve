// Error kinds and the text the card shows for each (SPEC §7.1). Shared by main and renderer: no Node imports.

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

/** The card text for `kind`; an unknown kind (e.g. from a stale renderer) gets the `internal` text. */
export function userMessage(kind: ErrorKind): string {
  return Object.hasOwn(MESSAGES, kind) ? MESSAGES[kind] : MESSAGES.internal;
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
