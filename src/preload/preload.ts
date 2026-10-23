// The renderer's whole view of main (SPEC §4.4 + Amendments 2, 9, 10, 11 and 15): exactly the sixteen functions, each bound to
// its one channel.
// No generic send/invoke passthrough; listeners get the payload only, never the IPC event.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type IpcEvents, type SnapsolveApi } from "../shared/ipc";

function subscribe<C extends keyof IpcEvents>(channel: C) {
  return (listener: (payload: IpcEvents[C]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: IpcEvents[C]) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => void ipcRenderer.removeListener(channel, handler);
  };
}

const api: SnapsolveApi = {
  onDelta: subscribe(IPC.answerDelta),
  onDone: subscribe(IPC.answerDone),
  onThreadsChanged: subscribe(IPC.threadsChanged),
  listThreads: () => ipcRenderer.invoke(IPC.threadsList),
  followUp: (threadId, text) => ipcRenderer.invoke(IPC.threadFollowUp, threadId, text),
  retry: (threadId) => ipcRenderer.invoke(IPC.threadRetry, threadId),
  newThread: (text) => (text === undefined ? ipcRenderer.invoke(IPC.threadNew) : ipcRenderer.invoke(IPC.threadNew, text)),
  openThread: (threadId) => ipcRenderer.invoke(IPC.threadOpen, threadId),
  hide: () => ipcRenderer.invoke(IPC.panelHide),
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  // No arguments cross: main opens a fixed URL / relaunches.
  openScreenRecordingSettings: () => ipcRenderer.invoke(IPC.screenRecordingSettingsOpen),
  relaunch: () => ipcRenderer.invoke(IPC.appRelaunch),
  onVoice: subscribe(IPC.voiceState),
  toggleVoice: () => ipcRenderer.invoke(IPC.voiceToggle),
  openVoiceSettings: () => ipcRenderer.invoke(IPC.voiceSettingsOpen),
};

contextBridge.exposeInMainWorld("snapsolve", api);
