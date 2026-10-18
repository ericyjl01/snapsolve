// Shared data shapes: config, threads and turns (DESIGN §3.5), IPC event payloads. Types only.
import type { ErrorKind } from "./errors";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Hotkeys {
  capture: string;
  append: string;
  /** Shows or hides the window (task 060). */
  toggle: string;
}

/** `<data>/config.json` (SPEC §6.1). Loaded and validated by `src/main/config.ts`. */
export interface Config {
  hotkeys: Hotkeys;
  model: string;
  effort: Effort;
  panelWidth: number;
  autoHideSec: number;
  /** null → `claude` on PATH, then `~/.local/bin`. */
  claudePath: string | null;
  allowApiKey: boolean;
  maxConcurrent: number;
  maxScreenshotsPerThread: number;
  timeoutSec: number;
}

/** `new`: created, no turn started yet. */
export type ThreadStatus = "new" | "queued" | "running" | "done" | "error";

export type UserTurn =
  | {
      role: "user";
      kind: "screenshot";
      file: string;
      text?: string;
      /**
       * A thread's first screenshot only, when an append past `maxScreenshotsPerThread` started the thread: the previous
       * thread's last answer, sent with the image (SPEC §2.3).
       */
      seed?: string;
    }
  | { role: "user"; kind: "text"; text: string };

export interface AssistantTurn {
  role: "assistant";
  text: string;
  durationMs: number;
  ttftMs: number | null;
  costUsd: number | null;
  isError: boolean;
  errorKind?: ErrorKind;
  /** What went wrong, for the card: Claude's own words for a usage limit, else the fixed user message. */
  errorMessage?: string;
  /** Set when resume failed and this answer came from a fresh session seeded with the thread's history. */
  note?: "resumeFallback";
  /** Set when this turn billed to an API key although `allowApiKey` is false (SPEC §3.6). */
  warning?: "apiKeyInUse";
  /** The usage after this turn, as the card footer shows it ("5h N% · 7d M%"). */
  usage?: string;
}

export type Turn = UserTurn | AssistantTurn;

/** `threads/<id>/thread.json`. */
export interface Thread {
  id: string;
  sessionId: string;
  /** Absolute path of the thread's own transcript copy; null until the first turn is adopted. */
  transcriptPath: string | null;
  model: string;
  effort: Effort;
  createdAt: string;
  title: string;
  status: ThreadStatus;
  turns: Turn[];
  /** Set when the first turn's transcript could not be adopted: the next turn takes the resume fallback. */
  transcriptMissing?: boolean;
  /**
   * Set only on the macOS Screen Recording card: a panel-only entry (never saved) whose one errored turn says what
   * to do; `prompted` picks the buttons (`screenRecordingCard`).
   */
  permission?: { prompted: boolean };
}

/** main → renderer: a streamed chunk of answer text. */
export interface AnswerDelta {
  threadId: string;
  text: string;
}

/** main → renderer: a turn ended; `thread` is its saved state. */
export interface AnswerDone {
  threadId: string;
  thread: Thread;
}
