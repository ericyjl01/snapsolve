// IPC contract: channel names (`area:verb`) and the preload API (SPEC §4.4, Amendments 2, 9, 10 and 11) that maps 1:1
// onto them.
import type { AnswerDelta, AnswerDone, Thread, VoiceState } from "./types";

export const IPC = {
  // main → renderer events
  answerDelta: "answer:delta",
  answerDone: "answer:done",
  threadsChanged: "threads:changed",
  // SPEC Amendment 11 (task 063): the voice composer's state.
  voiceState: "voice:state",
  // renderer → main requests (invoke/handle)
  threadsList: "threads:list",
  threadFollowUp: "thread:followUp",
  threadRetry: "thread:retry",
  // SPEC Amendment 10 (task 065): the title bar's "+", and a question typed after it.
  threadNew: "thread:new",
  externalOpen: "external:open",
  historyClear: "history:clear",
  // SPEC Amendment 9 (task 061): the title bar's ×; no argument.
  panelHide: "panel:hide",
  // SPEC Amendment 2 (macOS Screen Recording card); neither takes an argument.
  screenRecordingSettingsOpen: "settings:openScreenRecording",
  appRelaunch: "app:relaunch",
  // SPEC Amendment 11 (task 063): the mic buttons (as the voice hotkey) and the voice card's Open System Settings; no
  // argument.
  voiceToggle: "voice:toggle",
  voiceSettingsOpen: "settings:openVoice",
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
  newThread: IPC.threadNew,
  hide: IPC.panelHide,
  openExternal: IPC.externalOpen,
  clearHistory: IPC.historyClear,
  openScreenRecordingSettings: IPC.screenRecordingSettingsOpen,
  relaunch: IPC.appRelaunch,
  onVoice: IPC.voiceState,
  toggleVoice: IPC.voiceToggle,
  openVoiceSettings: IPC.voiceSettingsOpen,
} as const satisfies Record<keyof SnapsolveApi, IpcChannel>;

/** Payloads of main → renderer events. */
export interface IpcEvents {
  [IPC.answerDelta]: AnswerDelta;
  [IPC.answerDone]: AnswerDone;
  [IPC.threadsChanged]: Thread[];
  [IPC.voiceState]: VoiceState;
}

/** Arguments and results of renderer → main requests. */
export interface IpcRequests {
  [IPC.threadsList]: { args: []; result: Thread[] };
  [IPC.threadFollowUp]: { args: [threadId: string, text: string]; result: void };
  [IPC.threadRetry]: { args: [threadId: string]; result: void };
  [IPC.threadNew]: { args: [text?: string]; result: void };
  [IPC.panelHide]: { args: []; result: void };
  [IPC.externalOpen]: { args: [url: string]; result: void };
  [IPC.historyClear]: { args: []; result: boolean };
  [IPC.screenRecordingSettingsOpen]: { args: []; result: void };
  [IPC.appRelaunch]: { args: []; result: void };
  [IPC.voiceToggle]: { args: []; result: void };
  [IPC.voiceSettingsOpen]: { args: []; result: void };
}

/** The renderer-side API preload exposes via contextBridge (implemented in task 009). */
export interface SnapsolveApi {
  onDelta(listener: (e: AnswerDelta) => void): () => void;
  onDone(listener: (e: AnswerDone) => void): () => void;
  onThreadsChanged(listener: (threads: Thread[]) => void): () => void;
  listThreads(): Promise<Thread[]>;
  followUp(threadId: string, text: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  /** No text: the next capture or question starts a new thread ("+"). With text: starts a text thread with it now. */
  newThread(text?: string): Promise<void>;
  /** Hides the window, as Esc does (the title bar's ×). */
  hide(): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Resolves false if the user cancelled the confirm dialog. */
  clearHistory(): Promise<boolean>;
  /** macOS: main opens System Settings at Privacy & Security › Screen Recording (a fixed URL); elsewhere nothing. */
  openScreenRecordingSettings(): Promise<void>;
  /** Restarts the app (a new Screen Recording grant takes effect only in a new process). */
  relaunch(): Promise<void>;
  /** The voice composer's state as it changes (task 063). */
  onVoice(listener: (state: VoiceState) => void): () => void;
  /** A mic button: what the voice hotkey does (start; again: stop and send). */
  toggleVoice(): Promise<void>;
  /** macOS: main opens System Settings at the pane voice was refused (a fixed URL); elsewhere nothing. */
  openVoiceSettings(): Promise<void>;
}
