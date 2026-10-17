// IPC contract: channel names (`area:verb`) and the preload API (SPEC §4.4) that maps 1:1 onto them.
import type { AnswerDelta, AnswerDone, Thread } from "./types";

export const IPC = {
  // main → renderer events
  answerDelta: "answer:delta",
  answerDone: "answer:done",
  threadsChanged: "threads:changed",
  // renderer → main requests (invoke/handle)
  threadsList: "threads:list",
  threadFollowUp: "thread:followUp",
  threadRetry: "thread:retry",
  clipboardCopy: "clipboard:copy",
  externalOpen: "external:open",
  historyClear: "history:clear",
  // SPEC Amendment 2 (macOS Screen Recording card); neither takes an argument.
  screenRecordingSettingsOpen: "settings:openScreenRecording",
  appRelaunch: "app:relaunch",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Each preload function and the one channel it uses. No other channel is exposed to the renderer. */
export const PRELOAD_CHANNELS = {
  onDelta: IPC.answerDelta,
  onDone: IPC.answerDone,
  onThreadsChanged: IPC.threadsChanged,
  listThreads: IPC.threadsList,
  followUp: IPC.threadFollowUp,
  retry: IPC.threadRetry,
  copy: IPC.clipboardCopy,
  openExternal: IPC.externalOpen,
  clearHistory: IPC.historyClear,
  openScreenRecordingSettings: IPC.screenRecordingSettingsOpen,
  relaunch: IPC.appRelaunch,
} as const satisfies Record<keyof SnapsolveApi, IpcChannel>;

/** Payloads of main → renderer events. */
export interface IpcEvents {
  [IPC.answerDelta]: AnswerDelta;
  [IPC.answerDone]: AnswerDone;
  [IPC.threadsChanged]: Thread[];
}

/** Arguments and results of renderer → main requests. */
export interface IpcRequests {
  [IPC.threadsList]: { args: []; result: Thread[] };
  [IPC.threadFollowUp]: { args: [threadId: string, text: string]; result: void };
  [IPC.threadRetry]: { args: [threadId: string]; result: void };
  [IPC.clipboardCopy]: { args: [text: string]; result: void };
  [IPC.externalOpen]: { args: [url: string]; result: void };
  [IPC.historyClear]: { args: []; result: boolean };
  [IPC.screenRecordingSettingsOpen]: { args: []; result: void };
  [IPC.appRelaunch]: { args: []; result: void };
}

/** The renderer-side API preload exposes via contextBridge (implemented in task 009). */
export interface SnapsolveApi {
  onDelta(listener: (e: AnswerDelta) => void): () => void;
  onDone(listener: (e: AnswerDone) => void): () => void;
  onThreadsChanged(listener: (threads: Thread[]) => void): () => void;
  listThreads(): Promise<Thread[]>;
  followUp(threadId: string, text: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Resolves false if the user cancelled the confirm dialog. */
  clearHistory(): Promise<boolean>;
  /** macOS: main opens System Settings at Privacy & Security › Screen Recording (a fixed URL); elsewhere nothing. */
  openScreenRecordingSettings(): Promise<void>;
  /** Restarts the app (a new Screen Recording grant takes effect only in a new process). */
  relaunch(): Promise<void>;
}
