import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/main/app";
import { DEFAULTS } from "../../src/main/config";
import { createHotkeys } from "../../src/main/hotkeys";
import type { Logger } from "../../src/main/log";
import {
  createPermissionHandlers,
  darwinStartup,
  hotkeyLabel,
  hotkeySymbols,
  MICROPHONE_SETTINGS_URL,
  SCREEN_RECORDING_SETTINGS_URL,
  SPEECH_RECOGNITION_SETTINGS_URL,
} from "../../src/main/macos";
import { isSafeExternalUrl } from "../../src/main/panel";
import { screenRecordingCard, userMessage, voicePermissionCard } from "../../src/shared/errors";
import { IPC } from "../../src/shared/ipc";
import type { Thread } from "../../src/shared/types";

const LOGIN_OUT = "rc noise\n__SNAPSOLVE_PATH_BEGIN__/opt/login/bin:/usr/bin__SNAPSOLVE_PATH_END__";

function recordingLog() {
  const warnings: { event: string; fields?: unknown }[] = [];
  const log: Logger = {
    debug() {},
    info() {},
    warn: (event, fields) => void warnings.push({ event, fields }),
    error() {},
    flush: async () => {},
  };
  return { log, warnings };
}

describe("darwinStartup", () => {
  it("darwin: hides the Dock icon before creating the tray", () => {
    const order: string[] = [];
    const app = { dock: { hide: vi.fn(() => void order.push("dock.hide")) } };
    const result = darwinStartup({
      platform: "darwin",
      app,
      env: { PATH: "/usr/bin" },
      home: "/Users/eric",
      execFileSync: () => LOGIN_OUT,
      log: recordingLog().log,
      createTray: () => {
        order.push("createTray");
        return "tray";
      },
    });
    expect(order).toEqual(["dock.hide", "createTray"]);
    expect(result.tray).toBe("tray");
  });

  it("darwin: returns the merged login-shell PATH for the runner", () => {
    const execFileSync = vi.fn(() => LOGIN_OUT);
    const { env } = darwinStartup({
      platform: "darwin",
      app: { dock: { hide() {} } },
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/eric" },
      home: "/Users/eric",
      execFileSync,
      log: recordingLog().log,
      createTray: () => null,
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(env.HOME).toBe("/Users/eric");
    expect(env.PATH?.split(":")).toEqual([
      "/opt/login/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/eric/.local/bin",
    ]);
  });

  it("darwin: a failed login shell is logged as a warning and the extras are still added", () => {
    const { log, warnings } = recordingLog();
    const { env } = darwinStartup({
      platform: "darwin",
      app: { dock: { hide() {} } },
      env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
      home: "/Users/eric",
      execFileSync: () => {
        throw new Error("spawnSync /bin/zsh ETIMEDOUT");
      },
      log,
      createTray: () => null,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].event).toBe("app.loginPath");
    expect(JSON.stringify(warnings[0].fields)).toContain("ETIMEDOUT");
    expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/eric/.local/bin");
  });

  it("darwin without a Dock (app.dock undefined) still creates the tray", () => {
    const { tray } = darwinStartup({
      platform: "darwin",
      app: {},
      env: {},
      home: "/Users/eric",
      execFileSync: () => LOGIN_OUT,
      log: recordingLog().log,
      createTray: () => "tray",
    });
    expect(tray).toBe("tray");
  });

  it("win32: never touches app.dock, runs no shell and passes the env unchanged", () => {
    let touched = false;
    const app = {
      get dock() {
        touched = true;
        return { hide() {} };
      },
    };
    const execFileSync = vi.fn(() => LOGIN_OUT);
    const env = { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\eric\\AppData\\Local" };
    const { log, warnings } = recordingLog();
    const result = darwinStartup({ platform: "win32", app, env, home: "C:\\Users\\eric", execFileSync, log, createTray: () => "tray" });
    expect(touched).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(result.env).toEqual(env);
    expect(result.tray).toBe("tray");
    expect(warnings).toEqual([]);
  });
});

describe("screenRecordingDenied card model", () => {
  it("prompted: grant in the prompt, then Relaunch only", () => {
    expect(screenRecordingCard(true)).toEqual({
      message: "Grant Screen Recording in the prompt, then click Relaunch.",
      actions: ["relaunch"],
    });
  });

  it("not prompted (denied earlier): Open System Settings + Relaunch", () => {
    expect(screenRecordingCard(false)).toEqual({
      message: userMessage("screenRecordingDenied"),
      actions: ["openSettings", "relaunch"],
    });
  });
});

describe("voice permission card model (063)", () => {
  it("microphone denied: what to turn on, with Open System Settings only", () => {
    expect(voicePermissionCard("microphone")).toEqual({ message: userMessage("microphoneDenied"), actions: ["openSettings"] });
    expect(userMessage("microphoneDenied")).toMatch(/Microphone/);
  });

  it("helper failed: the failure, with no buttons", () => {
    expect(voicePermissionCard("failed")).toEqual({ message: userMessage("voiceFailed"), actions: [] });
  });

  it("speech recognition denied: what to turn on, with Open System Settings only", () => {
    expect(voicePermissionCard("speechRecognition")).toEqual({ message: userMessage("speechDenied"), actions: ["openSettings"] });
    expect(userMessage("speechDenied")).toMatch(/Speech Recognition/);
  });
});

describe("permission handlers (SPEC Amendment 2)", () => {
  function setup(platform: NodeJS.Platform, denial: "microphone" | "speechRecognition" | null = null) {
    const calls: string[] = [];
    const deps = {
      platform,
      voiceDenial: () => denial,
      openExternal: vi.fn(async (url: string) => void calls.push(`open ${url}`)),
      relaunch: vi.fn(() => void calls.push("relaunch")),
      exit: vi.fn(() => void calls.push("exit")),
      log: recordingLog().log,
    };
    return { handlers: createPermissionHandlers(deps), deps, calls };
  }

  it("Open System Settings opens exactly the fixed URL via main", async () => {
    const { handlers, deps } = setup("darwin");
    await handlers.openScreenRecordingSettings();
    expect(deps.openExternal).toHaveBeenCalledTimes(1);
    expect(deps.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    expect(SCREEN_RECORDING_SETTINGS_URL).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });

  it("ignores any arguments sent on its channel", async () => {
    const { handlers, deps } = setup("darwin");
    await (handlers.openScreenRecordingSettings as (...a: unknown[]) => Promise<void>)("https://evil.example", "file:///etc/passwd");
    expect(deps.openExternal.mock.calls).toEqual([[SCREEN_RECORDING_SETTINGS_URL]]);
  });

  it("does nothing outside macOS", async () => {
    const { handlers, deps } = setup("win32");
    await handlers.openScreenRecordingSettings();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("Open System Settings on a voice card opens the fixed pane of the last denial; never a URL from the renderer (063)", async () => {
    expect(MICROPHONE_SETTINGS_URL).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    expect(SPEECH_RECOGNITION_SETTINGS_URL).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition");
    const mic = setup("darwin", "microphone");
    await (mic.handlers.openVoiceSettings as (...a: unknown[]) => Promise<void>)("https://evil.example");
    expect(mic.deps.openExternal.mock.calls).toEqual([[MICROPHONE_SETTINGS_URL]]);
    const speech = setup("darwin", "speechRecognition");
    await speech.handlers.openVoiceSettings();
    expect(speech.deps.openExternal.mock.calls).toEqual([[SPEECH_RECOGNITION_SETTINGS_URL]]);
    // No denial recorded yet: the microphone pane (the first thing voice asks for).
    const none = setup("darwin", null);
    await none.handlers.openVoiceSettings();
    expect(none.deps.openExternal.mock.calls).toEqual([[MICROPHONE_SETTINGS_URL]]);
    const win = setup("win32", "microphone");
    await win.handlers.openVoiceSettings();
    expect(win.deps.openExternal).not.toHaveBeenCalled();
  });

  it("Relaunch calls relaunch, then exit", async () => {
    const { handlers, calls } = setup("darwin");
    await (handlers.relaunch as (...a: unknown[]) => Promise<void>)("ignored");
    expect(calls).toEqual(["relaunch", "exit"]);
  });

  it("openExternal still refuses an x-apple.systempreferences: URL", async () => {
    expect(isSafeExternalUrl(SCREEN_RECORDING_SETTINGS_URL)).toBe(false);
    const open = vi.fn(async () => {});
    const app = createApp({ ...appDeps(), openExternal: open });
    await expect(app.handlers.openExternal(SCREEN_RECORDING_SETTINGS_URL)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("hotkey label", () => {
  it("names the configured accelerator per platform", () => {
    expect(hotkeyLabel("Control+Alt+Q", "darwin")).toBe("Ctrl+Option+Q");
    expect(hotkeyLabel("Control+Alt+Q", "win32")).toBe("Ctrl+Alt+Q");
    expect(hotkeyLabel("Control+Alt+Shift+Q", "darwin")).toBe("Ctrl+Option+Shift+Q");
    expect(hotkeyLabel("Ctrl+Option+W", "win32")).toBe("Ctrl+Alt+W");
    expect(hotkeyLabel("CommandOrControl+Shift+X", "darwin")).toBe("Cmd+Shift+X");
    expect(hotkeyLabel("CommandOrControl+Shift+X", "win32")).toBe("Ctrl+Shift+X");
    expect(hotkeyLabel("Super+F1", "darwin")).toBe("Cmd+F1");
  });

  it("hotkeySymbols: the menu-bar form on macOS (⌃⌥⇧⌘), the label elsewhere (060 tray item)", () => {
    expect(hotkeySymbols("Control+Alt+X", "darwin")).toBe("⌃⌥X");
    expect(hotkeySymbols("Control+Alt+Shift+Q", "darwin")).toBe("⌃⌥⇧Q");
    expect(hotkeySymbols("CommandOrControl+Option+F9", "darwin")).toBe("⌘⌥F9");
    expect(hotkeySymbols("Control+Alt+X", "win32")).toBe("Ctrl+Alt+X");
  });

  it("the taken-hotkey notification names the default capture key as Ctrl+Option+C (064)", () => {
    const notify = vi.fn();
    const keys = createHotkeys({
      globalShortcut: { register: () => false, unregister() {}, isRegistered: () => false },
      config: { hotkeys: DEFAULTS.hotkeys },
      onCapture() {},
      onToggle() {},
      notify,
      label: (accelerator) => hotkeyLabel(accelerator, "darwin"),
    });
    keys.start();
    expect(notify).toHaveBeenCalledWith("Ctrl+Option+C is taken by another app. Change hotkeys.capture in config.json.");
  });

  it("the taken-hotkey notification uses the label", () => {
    const notify = vi.fn();
    const keys = createHotkeys({
      globalShortcut: { register: () => false, unregister() {}, isRegistered: () => false },
      // Shift is labelled too (the append key that showed it is gone, 065).
      config: { hotkeys: { capture: "Control+Alt+Q", toggle: "Control+Alt+Shift+X", voice: "Control+Alt+V" } },
      onCapture() {},
      onToggle() {},
      onVoice() {},
      notify,
      label: (accelerator) => hotkeyLabel(accelerator, "darwin"),
    });
    keys.start();
    expect(notify).toHaveBeenCalledWith("Ctrl+Option+Q is taken by another app. Change hotkeys.capture in config.json.");
    expect(notify).toHaveBeenCalledWith("Ctrl+Option+Shift+X is taken by another app. Change hotkeys.toggle in config.json.");
    expect(notify).toHaveBeenCalledWith("Ctrl+Option+V is taken by another app. Change hotkeys.voice in config.json.");
    expect(notify).toHaveBeenCalledTimes(3);
  });
});

function fakeThread(id: string): Thread {
  return {
    id,
    sessionId: "11111111-1111-4111-8111-111111111111",
    transcriptPath: null,
    model: "opus",
    effort: "high",
    createdAt: new Date(2026, 9, 17).toISOString(),
    title: "",
    status: "new",
    turns: [],
  };
}

function appDeps() {
  const sent: Thread[][] = [];
  const store = {
    listThreads: vi.fn(async () => [] as Thread[]),
    createThread: vi.fn(async () => fakeThread("22222222-2222-4222-8222-222222222222")),
    saveScreenshot: vi.fn(async () => ({ file: "001.png" })),
    getThread: vi.fn(async () => {
      throw new Error("not on disk");
    }),
  };
  return {
    store: store as unknown as Parameters<typeof createApp>[0]["store"],
    storeFns: store,
    runner: { enqueue: vi.fn(async () => ({ ok: true as const, thread: fakeThread("x") })), on: () => () => true },
    panel: {
      open: vi.fn(),
      send: vi.fn((channel: string, payload: unknown) => {
        if (channel === IPC.threadsChanged) sent.push(payload as Thread[]);
      }),
    },
    sent,
    config: { model: "opus", effort: "high" as const, maxScreenshotsPerThread: 6 },
    log: recordingLog().log,
    clipboard: { writeText() {} },
    openExternal: async () => {},
    confirmClearHistory: async () => true,
  };
}

describe("screenRecordingDenied card in the panel", () => {
  it("a denied capture opens the panel with one unsaved permission card", async () => {
    const deps = appDeps();
    const app = createApp(deps);
    await app.onCaptureDenied(true);
    expect(deps.panel.open).toHaveBeenCalled();
    const threads = deps.sent.at(-1) ?? [];
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      status: "error",
      permission: { prompted: true },
      turns: [{ role: "assistant", isError: true, errorKind: "screenRecordingDenied", errorMessage: screenRecordingCard(true).message }],
    });
    expect(deps.storeFns.createThread).not.toHaveBeenCalled();
    expect(deps.storeFns.saveScreenshot).not.toHaveBeenCalled();
    expect(await app.handlers.listThreads()).toEqual(threads);
  });

  it("a second denial replaces the card; a later capture removes it", async () => {
    const deps = appDeps();
    const app = createApp(deps);
    await app.onCaptureDenied(true);
    await app.onCaptureDenied(false);
    const threads = deps.sent.at(-1) ?? [];
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ permission: { prompted: false }, turns: [{ errorMessage: screenRecordingCard(false).message }] });

    await app.onCapture({ startedAt: 0, grabMs: 0, encode: () => ({ png: new Uint8Array([1]), pngMs: 0, encodeMs: 0 }) });
    const after = deps.sent.at(-1) ?? [];
    expect(after.map((t) => t.id)).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(after.some((t) => t.permission)).toBe(false);
  });

  it("Retry or a follow-up on the permission card queues nothing", async () => {
    const deps = appDeps();
    const app = createApp(deps);
    await app.onCaptureDenied(false);
    const [card] = deps.sent.at(-1) ?? [];
    await app.handlers.retry(card.id).catch(() => undefined);
    await app.handlers.followUp(card.id, "hello").catch(() => undefined);
    expect(deps.runner.enqueue).not.toHaveBeenCalled();
  });
});
