// IPC contract: channel names (`area:verb`) and the preload API (SPEC §4.4, Amendments 2, 9, 10, 11, 15 and 25) that maps
// 1:1 onto them.
import type { AnswerDelta, AnswerDone, ChatMode, Thread, VoiceState } from "./types";

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
  // SPEC Amendment 15 (task 078): a chat chosen in the sidebar becomes the one captures continue.
  threadOpen: "thread:open",
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
  // SPEC Amendment 25 (task 089): the title bar's Solve | Answer toggle — the mode new chats start in.
  modeGet: "mode:get",
  modeSet: "mode:set",
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
  openThread: IPC.threadOpen,
  hide: IPC.panelHide,
  openExternal: IPC.externalOpen,
  clearHistory: IPC.historyClear,
  openScreenRecordingSettings: IPC.screenRecordingSettingsOpen,
  relaunch: IPC.appRelaunch,
  onVoice: IPC.voiceState,
  toggleVoice: IPC.voiceToggle,
  openVoiceSettings: IPC.voiceSettingsOpen,
  getMode: IPC.modeGet,
  setMode: IPC.modeSet,
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
  [IPC.threadOpen]: { args: [threadId: string]; result: void };
  [IPC.panelHide]: { args: []; result: void };
  [IPC.externalOpen]: { args: [url: string]; result: void };
  [IPC.historyClear]: { args: []; result: boolean };
  [IPC.screenRecordingSettingsOpen]: { args: []; result: void };
  [IPC.appRelaunch]: { args: []; result: void };
  [IPC.voiceToggle]: { args: []; result: void };
  [IPC.voiceSettingsOpen]: { args: []; result: void };
  [IPC.modeGet]: { args: []; result: ChatMode };
  [IPC.modeSet]: { args: [mode: ChatMode]; result: void };
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
  /** A chat chosen in the sidebar: main makes it current, so the next capture or dictation continues it. */
  openThread(threadId: string): Promise<void>;
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
  /** The mode new chats start in (config.json `mode`, task 089). */
  getMode(): Promise<ChatMode>;
  /**
   * The toggle's choice: new chats start in `mode` from now on, and it is saved. The chat on screen keeps its own mode;
   * the renderer starts a new chat (`newThread()`) when switching while one is shown.
   */
  setMode(mode: ChatMode): Promise<void>;
}
