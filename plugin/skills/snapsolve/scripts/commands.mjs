// The /snapsolve commands (DESIGN §4.2–4.3). Each composes the steps in steps.mjs and returns
// `{ code, lines }`: short `ok:` / `warn:` / `fail:` lines the skill relays, code 1 when any line failed. Everything
// comes in through `ctx` (platform, env, home, nodeVersion, the plugin's `app/` payload, `paths()` = installPaths,
// the steps), so tests run the flows over fakes. Install state lives in `<data>/app/install.json`.
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { compareVersions, exists, linkExists, readJson, renameRetrying } from "./steps.mjs";

export const COMMANDS = ["install", "start", "update", "doctor", "uninstall"];
export const USAGE = "usage: node snapsolve.mjs install | start | update | doctor | uninstall [--purge]";

const INSTALL_HINT = "run /snapsolve install";
const SUPPORTED = ["win32", "darwin"];
const STATE_FILE = "install.json";
const DEFAULT_HOTKEY = "Control+Alt+Q";
const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** argv (after the script) → `{ command, purge }`, or `{ usage }`. `--purge` only goes with uninstall. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) return { usage: USAGE };
  if (rest.length === 0) return { command, purge: false };
  if (command === "uninstall" && rest.length === 1 && rest[0] === "--purge") return { command, purge: true };
  return { usage: USAGE };
}

export function runCommand({ command, purge }, ctx) {
  switch (command) {
    case "install":
      return install(ctx);
    case "start":
      return start(ctx);
    case "update":
      return update(ctx);
    case "doctor":
      return doctor(ctx);
    case "uninstall":
      return uninstall(ctx, { purge });
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/**
 * preflight → (quit a previous install) → stage → point current → package the launcher (first install, a changed
 * Electron version, or a missing exe) → claudePath → install.json → launch; then the hotkey, and the AltGr note
 * (Windows) or the Screen Recording grant (macOS). A step failing after the quit restarts the previous version.
 */
export function install(ctx) {
  return flow(async (out) => {
    const { steps, platform, env, home } = ctx;
    const pre = await steps.preflight({ platform, nodeVersion: ctx.nodeVersion, env, home });
    for (const warning of pre.warnings) out.warn(warning);
    if (!pre.ok) {
      for (const problem of pre.problems) out.fail(problem);
      return;
    }

    const paths = ctx.paths();
    const state = await readState(paths.appRoot);
    if (state) await steps.quitAndWait({ exe: state.exe ?? paths.exe, platform });
    const staged = await afterQuit(ctx, paths, state, "install", out, async () => {
      const staged = await stage(ctx, paths, out);
      const electron = await electronVersion(staged.dir);
      if (!state || state.electronVersion !== electron || !(await exists(paths.exe))) {
        await packageLauncher(ctx, paths, staged, electron, out, { replacing: Boolean(state) });
      }
      const written = await steps.writeClaudePath({ configFile: paths.config, claudePath: pre.claudePath, platform });
      if (written.warning) out.warn(written.warning);
      await writeState(paths.appRoot, { version: staged.version, electronVersion: electron, exe: paths.exe });
      return staged;
    });
    if (!staged || !(await launchApp(ctx, paths.exe, out))) return;

    out.ok(`snapsolve ${staged.version} is installed and running (Claude Code ${pre.claudeVersion}).`);
    const hotkey = await captureHotkey(paths.config);
    out.ok(`Press ${hotkeyLabel(hotkey, platform)} to capture the screen (hotkeys.capture in ${paths.config}).`);
    if (platform === "darwin") {
      out.ok(
        "The first capture makes macOS ask for Screen Recording: turn snapsolve on in System Settings → " +
          "Privacy & Security → Screen Recording, then click Relaunch on the snapsolve card.",
      );
    } else if (isCtrlAlt(hotkey)) {
      out.ok(
        `On keyboards with AltGr (German, French, Polish, ...) Ctrl+Alt acts as AltGr, so ${hotkeyLabel(hotkey, platform)} ` +
          `takes over AltGr+${hotkeyKey(hotkey)}; if you type with that key, change hotkeys.capture.`,
      );
    }
  });
}

/** Launches the installed app; not installed → the install hint. */
export function start(ctx) {
  return flow(async (out) => {
    const paths = ctx.paths();
    const state = await readState(paths.appRoot);
    const exe = state?.exe ?? paths.exe;
    if (!state || !(await exists(exe))) {
      out.fail(`snapsolve is not installed: ${INSTALL_HINT}`);
      return;
    }
    if (await launchApp(ctx, exe, out)) out.ok(`snapsolve started (${exe}).`);
  });
}

/**
 * Same version → nothing to do. Otherwise quit → stage → point current → package only if Electron changed (or the
 * exe is gone) → install.json → keep only the new and the previous version dirs → relaunch. A step failing after
 * the quit restarts the previous version.
 */
export function update(ctx) {
  return flow(async (out) => {
    const { steps } = ctx;
    const paths = ctx.paths();
    const state = await readState(paths.appRoot);
    if (!state) {
      out.fail(`snapsolve is not installed: ${INSTALL_HINT}`);
      return;
    }
    const pluginVersion = await payloadVersion(ctx.pluginApp);
    if (compareVersions(state.version, pluginVersion) === 0) {
      out.ok(`snapsolve ${pluginVersion} is up to date.`);
      return;
    }

    await steps.quitAndWait({ exe: state.exe ?? paths.exe, platform: ctx.platform });
    const staged = await afterQuit(ctx, paths, state, "update", out, async () => {
      const staged = await stage(ctx, paths, out);
      const electron = await electronVersion(staged.dir);
      if (state.electronVersion !== electron || !(await exists(paths.exe))) {
        await packageLauncher(ctx, paths, staged, electron, out, { replacing: true });
      }
      await writeState(paths.appRoot, { version: staged.version, electronVersion: electron, exe: paths.exe });
      return staged;
    });
    if (!staged) return;
    await pruneVersions(paths.appRoot, [staged.version, state.version], out);
    if (await launchApp(ctx, paths.exe, out)) out.ok(`snapsolve updated ${state.version} → ${staged.version} and restarted.`);
  });
}

/**
 * Quits the app, then removes the launcher (Programs dir or .app bundle), the Start-menu shortcut (Windows) and
 * `<data>/app`. History, config and logs stay unless `purge`, which removes the whole data dir. The CLI never asks;
 * the skill asks before `--purge`.
 */
export function uninstall(ctx, { purge = false } = {}) {
  return flow(async (out) => {
    const paths = ctx.paths();
    const state = await readState(paths.appRoot);
    const targets = [paths.programs, paths.shortcut, purge ? paths.data : paths.appRoot].filter(Boolean);
    const present = [];
    for (const target of targets) if (await linkExists(target)) present.push(target);
    if (present.length === 0) {
      out.ok("snapsolve is not installed: nothing to remove.");
      return;
    }

    if (state || (await exists(paths.exe))) await ctx.steps.quitAndWait({ exe: state?.exe ?? paths.exe, platform: ctx.platform });
    for (const target of present) {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      out.ok(`removed ${target}`);
    }
    if (!purge && (await exists(paths.data))) {
      out.ok(`kept your history, config and logs in ${paths.data} (/snapsolve uninstall --purge deletes them).`);
    }
  });
}

/**
 * Node, Claude Code and its login (via preflight), installed vs plugin version, the launcher, the smoke / Defender
 * ASR check (DECISIONS 020) and config.json's claudePath. Exit 1 when any line failed.
 */
export function doctor(ctx) {
  return flow(async (out) => {
    const { steps, platform } = ctx;
    const pre = await steps.preflight({ platform, nodeVersion: ctx.nodeVersion, env: ctx.env, home: ctx.home });
    const nodeProblem = pre.problems.find((p) => p.startsWith("Node "));
    if (nodeProblem) out.fail(nodeProblem);
    else if (SUPPORTED.includes(platform)) out.ok(`Node ${ctx.nodeVersion}`);
    if (pre.claudeVersion) out.ok(`Claude Code ${pre.claudeVersion} (${pre.claudePath})`);
    if (pre.auth?.loggedIn === true) {
      out.ok(`logged in to Claude (${[pre.auth.authMethod, pre.auth.subscriptionType].filter(Boolean).join(", ")})`);
    }
    for (const problem of pre.problems) if (problem !== nodeProblem) out.fail(problem);
    for (const warning of pre.warnings) out.warn(warning);
    if (!SUPPORTED.includes(platform)) return;

    const paths = ctx.paths();
    const state = await readState(paths.appRoot);
    if (!state) {
      out.fail(`snapsolve is not installed: ${INSTALL_HINT}`);
      return;
    }
    const pluginVersion = await payloadVersion(ctx.pluginApp).catch(() => null);
    const order = compareVersions(state.version, pluginVersion);
    if (pluginVersion === null) out.warn(`cannot read the plugin's app version in ${ctx.pluginApp}`);
    else if (order === null) {
      out.warn(
        `cannot compare snapsolve ${state.version} installed with the plugin's ${pluginVersion}: run /snapsolve update to install the plugin's version`,
      );
    } else if (order === 0) out.ok(`snapsolve ${state.version} installed (the plugin's version)`);
    else if (order < 0) out.warn(`snapsolve ${state.version} installed, the plugin has ${pluginVersion}: run /snapsolve update`);
    else out.warn(`snapsolve ${state.version} installed is newer than the plugin's ${pluginVersion}`);

    const exe = state.exe ?? paths.exe;
    if (!(await exists(exe))) {
      out.fail(`${exe} is missing: ${INSTALL_HINT}`);
    } else {
      out.ok(`launcher ${exe}`);
      const smoke = await steps.asrCheck({ exe });
      if (smoke.status === "ok") out.ok("snapsolve starts (smoke test)");
      else if (smoke.status === "blocked") out.fail(platform === "win32" ? asrBlocked(exe) : notStartable(exe, smoke.output));
      else out.fail(`${exe} --smoke failed: ${smoke.output}`);
    }

    const config = await readJson(paths.config);
    if (config === undefined) {
      out.fail(`${paths.config} is missing or not JSON: ${INSTALL_HINT}`);
    } else if (config?.claudePath == null) {
      out.warn(`claudePath is not set in ${paths.config}; the app looks for claude on PATH, then in ~/.local/bin`);
    } else if (await exists(config.claudePath)) {
      out.ok(`claudePath ${config.claudePath}`);
    } else {
      out.fail(`claudePath ${config.claudePath} does not exist: ${INSTALL_HINT} to update it`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------

/** Runs a command body; a thrown error becomes its fail: line. */
async function flow(body) {
  const lines = [];
  const out = {
    ok: (message) => lines.push(`ok: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    fail: (message) => lines.push(`fail: ${message}`),
  };
  try {
    await body(out);
  } catch (e) {
    out.fail(messageOf(e));
  }
  return { code: lines.some((l) => l.startsWith("fail:")) ? 1 : 0, lines };
}

/**
 * Runs the steps that follow a successful quit of the installed app (`state` = its install.json; none on a first
 * install, so nothing was quit and an error just propagates). When a step throws, the app would stay stopped: the
 * error becomes a fail: line, then the previous version is started again if `current` still points at it (the
 * failure came before the flip) and its exe is there. Otherwise a second fail: line says snapsolve is not running
 * and what to run. Returns the body's result, or null after a failure.
 */
async function afterQuit(ctx, paths, state, command, out, body) {
  if (!state) return body();
  try {
    return await body();
  } catch (e) {
    out.fail(messageOf(e));
    const exe = state.exe ?? paths.exe;
    if (!(await sameDir(path.join(paths.appRoot, "current"), path.join(paths.appRoot, state.version)))) {
      out.fail(
        `snapsolve is not running (current no longer points at ${state.version}): fix the problem above, ` +
          `then run /snapsolve ${command} again`,
      );
    } else if (!(await exists(exe))) {
      out.fail(`snapsolve is not running and ${exe} is gone: fix the problem above, then run /snapsolve install`);
    } else if (await launchApp(ctx, exe, out)) {
      out.warn(`restarted the previous snapsolve ${state.version}; the ${command} did not finish`);
    } else {
      out.fail("snapsolve is not running: run /snapsolve start");
    }
    return null;
  }
}

async function stage(ctx, paths, out) {
  const { steps, platform } = ctx;
  const staged = await steps.stageVersion({ source: ctx.pluginApp, appRoot: paths.appRoot, platform });
  for (const warning of staged.warnings ?? []) out.warn(warning);
  await steps.pointCurrent({ appRoot: paths.appRoot, version: staged.version, platform });
  return staged;
}

/**
 * Packages the launcher. On macOS a launcher that replaces an earlier one is signed again, which is a new identity
 * for the Screen Recording grant (DESIGN §4.3), so the user is told macOS will ask again.
 */
async function packageLauncher(ctx, paths, staged, electron, out, { replacing = false } = {}) {
  const built = await ctx.steps.packageBootstrap({
    versionDir: staged.dir,
    programs: paths.programs,
    shortcut: paths.shortcut,
    platform: ctx.platform,
  });
  for (const warning of built?.warnings ?? []) out.warn(warning);
  const mac = ctx.platform === "darwin";
  out.ok(`launcher built with Electron ${electron}: ${mac ? paths.programs : paths.exe}`);
  if (mac && replacing) {
    out.warn(
      `${paths.programs} was rebuilt and signed again, so macOS will ask for Screen Recording again: allow snapsolve ` +
        "in System Settings → Privacy & Security → Screen Recording (remove the old snapsolve entry if the toggle " +
        "looks stuck), then click Relaunch on the snapsolve card.",
    );
  }
}

/** Launches `exe`; a denied spawn (EPERM) is Defender ASR's block on Windows (DESIGN §10 risk 6). False when it failed. */
async function launchApp(ctx, exe, out) {
  try {
    await ctx.steps.launch({ exe, env: ctx.env, platform: ctx.platform });
    return true;
  } catch (e) {
    if (ctx.platform === "win32" && (e?.code === "EPERM" || e?.cause?.code === "EPERM")) out.fail(asrBlocked(exe));
    else out.fail(`cannot start ${exe}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function asrBlocked(exe) {
  return `Defender ASR blocks ${exe}; ask IT for an exclusion for it.`;
}

/**
 * A denied spawn outside Windows (no Defender there): the bundle cannot be executed as it is. `install` alone would
 * not rebuild a present launcher of the same Electron version, so uninstall (history kept) and install again.
 */
function notStartable(exe, output) {
  return (
    `${exe} cannot be started (${output}): run /snapsolve uninstall, then /snapsolve install to rebuild it ` +
    "(your history is kept)."
  );
}

/** Removes version dirs under `appRoot` other than `keep`; anything else there is left alone. */
async function pruneVersions(appRoot, keep, out) {
  for (const entry of await fsp.readdir(appRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name) || keep.includes(entry.name)) continue;
    const dir = path.join(appRoot, entry.name);
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      out.warn(`could not remove the old version ${dir} (${e?.code ?? e?.message}); delete it by hand`);
    }
  }
}

/** True when both paths resolve to the same directory (links followed); false when either is missing. */
async function sameDir(a, b) {
  try {
    const [ra, rb] = await Promise.all([fsp.realpath(a), fsp.realpath(b)]);
    return ra === rb;
  } catch {
    return false;
  }
}

function messageOf(e) {
  return e instanceof Error ? e.message : String(e);
}

async function readState(appRoot) {
  const state = await readJson(path.join(appRoot, STATE_FILE));
  return state && typeof state === "object" && typeof state.version === "string" ? state : null;
}

/** install.json via temp + rename, retried while Defender holds the new file. */
async function writeState(appRoot, state) {
  const file = path.join(appRoot, STATE_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
    await renameRetrying(temp, file);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function payloadVersion(pluginApp) {
  const version = (await readJson(path.join(pluginApp, "package.json")))?.version;
  if (typeof version !== "string") throw new Error(`the plugin's ${path.join(pluginApp, "package.json")} has no version`);
  return version;
}

async function electronVersion(versionDir) {
  const pkg = await readJson(path.join(versionDir, "package.json"));
  return pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron ?? null;
}

async function captureHotkey(configFile) {
  const capture = (await readJson(configFile))?.hotkeys?.capture;
  return typeof capture === "string" && capture ? capture : DEFAULT_HOTKEY;
}

const KEY_LABELS = {
  control: "Ctrl",
  ctrl: "Ctrl",
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  altgr: "AltGr",
  shift: "Shift",
  super: "Win",
  meta: "Win",
};

// macOS names for the modifiers that differ (DESIGN §7: Ctrl+Option+Q).
const MAC_KEY_LABELS = { ...KEY_LABELS, alt: "Option", option: "Option", commandorcontrol: "Cmd", cmdorctrl: "Cmd", command: "Cmd", cmd: "Cmd", super: "Cmd", meta: "Cmd" };

/** "Control+Alt+Q" → "Ctrl+Alt+Q" on Windows, "Ctrl+Option+Q" on macOS. */
function hotkeyLabel(accelerator, platform = "win32") {
  const labels = platform === "darwin" ? MAC_KEY_LABELS : KEY_LABELS;
  return accelerator
    .split("+")
    .map((t) => labels[t.toLowerCase()] ?? (t.length === 1 ? t.toUpperCase() : t))
    .join("+");
}

function hotkeyKey(accelerator) {
  const key = accelerator.split("+").at(-1) ?? "";
  return key.length === 1 ? key.toUpperCase() : key;
}

function isCtrlAlt(accelerator) {
  const labels = hotkeyLabel(accelerator).split("+");
  return labels.includes("Ctrl") && labels.includes("Alt");
}
