import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { SnapsolveError, userMessage } from "../shared/errors";
import { IPC } from "../shared/ipc";
import { createApp, resolveClaudeCommand, type Shot } from "./app";
import { createCapturer } from "./capture";
import { loadConfig } from "./config";
import { encodeForModel } from "./encode";
import { createHotkeys } from "./hotkeys";
import { createLogger, type Logger } from "./log";
import { createPanel, resolveSnapsolveUrl, SCHEME } from "./panel";
import { dataPaths, ensureDirs, resolveDataDir } from "./paths";
import { buildEnv, createRunner, type Command, type SendImage } from "./runner";
import { createStore } from "./store";
import { createTray, drawTrayIcon, type TrayControl } from "./tray";

// `electron dist/main.js` does not read package.json, so name and version are injected at build time.
app.setName(__APP_NAME__);

// Electron's own files (caches, Local State) live in <data>/electron, never in Roaming %APPDATA% (SPEC §5.1).
// Must run before `ready`. An unresolvable data dir keeps Electron's default; the app reports it once wired.
try {
  app.setPath("userData", path.join(resolveDataDir(process.platform, process.env, os.homedir()), "electron"));
} catch (e) {
  process.stderr.write(`snapsolve: ${e instanceof Error ? e.message : String(e)}\n`);
}

// The renderer and thumbnails are served from snapsolve:// (never file://, SPEC §4.4); must be declared before `ready`.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

if (process.argv.includes("--smoke")) {
  void app.whenReady().then(() => {
    process.stdout.write(`snapsolve smoke ok ${__APP_VERSION__}\n`);
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  // SPEC §1.2: the running instance gets `second-instance` (opens the panel, or quits on --quit); this one leaves.
  app.quit();
} else if (process.argv.includes("--quit")) {
  // Nothing else is running, so there is nothing to quit; never start the app for --quit.
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--quit")) app.quit();
    else openPanel?.();
  });
  void app.whenReady().then(start).catch((e: unknown) => {
    const kind = e instanceof SnapsolveError ? e.kind : "internal";
    process.stderr.write(`snapsolve: ${e instanceof Error ? e.message : String(e)}\n`);
    dialog.showErrorBox("snapsolve", userMessage(kind));
    app.exit(1);
  });
}

/** Set once the panel exists; a second launch before that is ignored (the app is still starting). */
let openPanel: (() => void) | null = null;
/** Module-level so the tray is never garbage-collected. */
let tray: TrayControl | null = null;

async function start(): Promise<void> {
  const home = os.homedir();
  const dataDir = resolveDataDir(process.platform, process.env, home);
  const paths = dataPaths(dataDir);
  await ensureDirs(paths);
  const log = createLogger(paths.logFile);
  const { config } = await loadConfig(paths.config, { log });

  // Test mode (SNAPSOLVE_TEST=1, e2e only): claude is a node script run by Electron as node, transcripts are looked
  // for in a temp projects dir, and `snapsolveTest` feeds fixture PNGs through the capture path.
  const test = process.env.SNAPSOLVE_TEST === "1";
  const fakeClaude = test ? process.env.SNAPSOLVE_TEST_CLAUDE : undefined;
  const command: Command | (() => Command) = fakeClaude
    ? { path: process.execPath, prefixArgs: [fakeClaude] }
    : () => resolveClaudeCommand({ claudePath: config.claudePath, env: process.env, platform: process.platform, home, isFile });
  const env = fakeClaude ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
  const projectsDir = (test && process.env.SNAPSOLVE_TEST_PROJECTS) || path.join(home, ".claude", "projects");

  const store = createStore({
    dataDir,
    projectsDir,
    log,
    purge: (sessionsDir) => purge(typeof command === "function" ? command() : command, sessionsDir, buildEnv(env, config.allowApiKey)),
  });
  const runner = createRunner({
    command,
    store,
    config,
    systemPrompt: await readSystemPrompt(),
    env,
    spawn,
    sessionsDir: paths.sessions,
    log,
    loadSendImage,
  });

  const rendererDir = path.join(__dirname, "renderer");
  protocol.handle(SCHEME, async (request) => {
    const hit = await resolveSnapsolveUrl(request.url, { store, rendererDir });
    if (!hit) return new Response("Not found", { status: 404 });
    return new Response(await readFile(hit.path), { headers: { "content-type": hit.mime } });
  });

  const panel = createPanel({
    BrowserWindow,
    screen,
    ipcMain,
    platform: process.platform,
    preloadPath: path.join(__dirname, "preload.js"),
    config,
    log,
  });
  const core = createApp({
    store,
    runner,
    panel,
    config,
    log,
    clipboard,
    openExternal: (url) => shell.openExternal(url),
    confirmClearHistory: async () => {
      // No parent window: the tray asks too, and a sheet on the 8 px tab would be lost.
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Clear history", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "Delete every saved screenshot, answer and transcript?",
        detail: "This cannot be undone.",
      });
      return response === 0;
    },
    onTurnEnded: () => panel.turnEnded(),
  });
  panel.handle({
    [IPC.threadsList]: core.handlers.listThreads,
    [IPC.threadFollowUp]: core.handlers.followUp,
    [IPC.threadRetry]: core.handlers.retry,
    [IPC.clipboardCopy]: core.handlers.copy,
    [IPC.externalOpen]: core.handlers.openExternal,
    [IPC.historyClear]: core.handlers.clearHistory,
  });

  const notify = (body: string) => {
    if (Notification.isSupported()) new Notification({ title: "snapsolve", body }).show();
    else log.warn("app.notifyUnsupported", {});
  };
  const capturer = createCapturer({
    desktopCapturer,
    screen,
    panel,
    mediaAccess: systemPreferences,
    platform: process.platform,
    osRelease: os.release(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  /** Hotkey press → capture → pipeline; a failed capture is logged and shown as a notification. */
  const captureInto = (into: (shot: Shot) => Promise<string>) => () =>
    void capturer
      .capture()
      .then(into)
      .catch((e: unknown) => {
        log.warn("app.captureFailed", { error: e });
        notify(userMessage(e instanceof SnapsolveError ? e.kind : "internal"));
      });
  const hotkeys = createHotkeys({
    globalShortcut,
    config,
    onCapture: captureInto(core.onCapture),
    onAppend: captureInto(core.onAppend),
    notify,
    log,
  });
  hotkeys.start();
  app.on("will-quit", () => globalShortcut.unregisterAll());

  tray = createTray({
    Tray,
    Menu,
    image: trayImage(process.platform),
    onOpenPanel: () => panel.toggle(),
    onPause: () => hotkeys.pause(),
    onResume: () => hotkeys.resume(),
    onOpenHistory: () => void openFolder(paths.threads, log),
    onClearHistory: () => void core.handlers.clearHistory().catch((e: unknown) => log.error("app.clearFailed", { error: e })),
    onQuit: () => app.quit(),
  });

  openPanel = () => panel.open();
  powerMonitor.on("resume", () => hotkeys.reRegisterIfLost());
  for (const event of ["display-added", "display-removed", "display-metrics-changed"] as const) {
    screen.on(event as "display-added", () => panel.redock());
  }

  if (test) {
    (globalThis as { snapsolveTest?: unknown }).snapsolveTest = {
      /** Feeds a PNG file through the same path as a capture; resolves with the new thread's id. */
      captureFromFile: async (png: string) => core.onCapture({ png: readImage(png).toPNG() }),
      /** The same through the append path (the most recent capture's thread). */
      appendFromFile: async (png: string) => core.onAppend({ png: readImage(png).toPNG() }),
      hotkeyStatus: () => hotkeys.status(),
    };
  }
  log.info("app.ready", { version: __APP_VERSION__, platform: process.platform, test });
}

/** The tray icon, drawn in code: a black template image on macOS (the menu bar tints it), blue on Windows. */
function trayImage(platform: NodeJS.Platform): Electron.NativeImage {
  const rgb = platform === "darwin" ? ([0, 0, 0] as const) : ([9, 105, 218] as const);
  const image = nativeImage.createFromBitmap(drawTrayIcon(32, rgb), { width: 32, height: 32, scaleFactor: 2 });
  if (platform === "darwin") image.setTemplateImage(true);
  return image;
}

/** Tray "Open history folder": the threads/ dir (created if missing) in Explorer / Finder. */
async function openFolder(dir: string, log: Logger): Promise<void> {
  const error = await shell.openPath(dir);
  if (error) log.warn("app.openFolderFailed", { dir, error });
}

/** prompts/system.md beside main.js (the released app/) or one level up (dev: dist/main.js). */
async function readSystemPrompt(): Promise<string> {
  const candidates = [path.join(__dirname, "prompts", "system.md"), path.join(__dirname, "..", "prompts", "system.md")];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new SnapsolveError("internal", `prompts/system.md not found next to ${__dirname}`);
  return readFile(file, "utf8");
}

function readImage(file: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new SnapsolveError("internal", `cannot read image ${path.basename(file)}`);
  return image;
}

/** A saved screenshot as the model receives it (SPEC §2.3). */
async function loadSendImage(file: string): Promise<SendImage> {
  const encoded = encodeForModel(readImage(file));
  return { mediaType: encoded.mime, data: encoded.buf.toString("base64") };
}

/** SPEC §5.1: `claude purge "<data>/sessions" -y`, the sweep after clear history deletes threads/. */
function purge(command: Command, sessionsDir: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command.path,
      [...command.prefixArgs, "purge", sessionsDir, "-y"],
      { env, windowsHide: true, timeout: 60_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
