// Installer steps (DESIGN §4.2–4.3) that the /snapsolve commands compose: preflight, stage a version, point
// `current` at it, package the bootstrap launcher, write claudePath, launch, quit-and-wait and the Defender ASR check.
// Plain Node ESM with built-ins only: it runs from the plugin before anything is installed, possibly on a Node older
// than the minimum it checks for. Every step takes its dependencies (platform, env, home, exec, fs, clock, packager
// loader) so tests run with fakes and temp dirs; platform-specific paths use path.win32 / path.posix accordingly.
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The floor `@electron/packager` 20.3.0 declares (DECISIONS 2026-10-14). */
export const MIN_NODE = "22.12.0";

const APP_DIR = "snapsolve";
const NODE_HINT = { win32: "winget install OpenJS.NodeJS.LTS", darwin: "brew install node" };
const LOGIN_HINT = "Run `claude` once and log in.";
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
// Defender and the indexer briefly hold freshly written files (docs/issues.md, tasks 006 and 022).
const RENAME_DELAYS_MS = [20, 50, 100, 200, 400, 800, 1000, 1000];

const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

/** The app's config.json defaults; mirrors DEFAULTS in src/main/config.ts (test/unit/installer-steps.test.ts). */
function defaultConfig() {
  return {
    hotkeys: { capture: "Control+Alt+Q", append: "Control+Alt+Shift+Q" },
    model: "opus",
    effort: "high",
    panelWidth: 420,
    autoHideSec: 0,
    claudePath: null,
    allowApiKey: false,
    maxConcurrent: 2,
    maxScreenshotsPerThread: 6,
    timeoutSec: 180,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** Same rules as `resolveDataDir` in src/main/paths.ts (and bootstrap/boot.js); throws instead of guessing. */
export function dataDir(platform, env, home) {
  const p = pathFor(platform);

  const override = env.SNAPSOLVE_DATA_DIR;
  if (override) {
    if (!p.isAbsolute(override)) throw new Error(`SNAPSOLVE_DATA_DIR must be an absolute path, got "${override}"`);
    return p.normalize(override);
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (!local || !p.isAbsolute(local)) throw new Error(`LOCALAPPDATA is not an absolute path: "${local ?? ""}"`);
    return p.join(local, APP_DIR);
  }
  if (platform === "darwin") {
    if (!home || !p.isAbsolute(home)) throw new Error(`home directory is not an absolute path: "${home}"`);
    return p.join(home, "Library", "Application Support", APP_DIR);
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/**
 * Where everything goes. `programs` is what packaging replaces: `%LOCALAPPDATA%\Programs\snapsolve` (plus a
 * Start-menu shortcut) on Windows, `~/Applications/snapsolve.app` (no shortcut) on macOS; `exe` is the binary in it.
 */
export function installPaths({ platform, env, home }) {
  const p = pathFor(platform);
  const data = dataDir(platform, env, home);
  const paths = {
    data,
    appRoot: p.join(data, "app"),
    current: p.join(data, "app", "current"),
    config: p.join(data, "config.json"),
  };
  if (platform === "darwin") {
    const bundle = p.join(home, "Applications", `${APP_DIR}.app`);
    return { ...paths, programs: bundle, exe: p.join(bundle, "Contents", "MacOS", APP_DIR), shortcut: null };
  }
  if (platform !== "win32") return paths;

  const local = env.LOCALAPPDATA;
  if (!local || !p.isAbsolute(local)) throw new Error(`LOCALAPPDATA is not an absolute path: "${local ?? ""}"`);
  const roaming = env.APPDATA;
  if (!roaming || !p.isAbsolute(roaming)) throw new Error(`APPDATA is not an absolute path: "${roaming ?? ""}"`);
  const programs = p.join(local, "Programs", APP_DIR);
  return {
    ...paths,
    programs,
    exe: p.join(programs, `${APP_DIR}.exe`),
    shortcut: p.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", `${APP_DIR}.lnk`),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight

/**
 * SPEC §6.1's lookup: PATH, then `~/.local/bin`. On Windows only `claude.exe` counts: the app spawns claude without
 * a shell, which cannot run the npm `claude.cmd` shim. Null when there is none.
 */
export function resolveClaude({ platform, env, home, isFile = isFileSync }) {
  const p = pathFor(platform);
  const name = platform === "win32" ? "claude.exe" : "claude";
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d && p.isAbsolute(d));
  dirs.push(p.join(home, ".local", "bin"));
  for (const dir of dirs) {
    const candidate = p.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Checks the platform, Node and Claude Code (`--version`, `auth status`). Problems block the install; warnings
 * (an API-key login) do not. A wrong platform stops at once; otherwise every problem found is reported together.
 */
export async function preflight({
  platform,
  nodeVersion = process.version,
  env = process.env,
  home = os.homedir(),
  exec = run,
  isFile = isFileSync,
}) {
  const problems = [];
  const warnings = [];
  const result = (found = {}) => ({
    ok: problems.length === 0,
    problems,
    warnings,
    claudePath: null,
    claudeVersion: null,
    auth: null,
    ...found,
  });

  if (platform !== "win32" && platform !== "darwin") {
    problems.push(`${platform} is not supported: snapsolve runs on Windows and macOS.`);
    return result();
  }

  const nodeOrder = compareVersions(nodeVersion, MIN_NODE);
  if (nodeOrder === null || nodeOrder < 0) {
    problems.push(`Node ${nodeVersion} is too old: snapsolve needs Node ≥ 22.12. Install the current LTS: ${NODE_HINT[platform]}`);
  }

  const p = pathFor(platform);
  const notFound =
    `Claude Code not found (no ${platform === "win32" ? "claude.exe" : "claude"} on PATH or in ${p.join(home, ".local", "bin")}). ` +
    "Install Claude Code, then run /snapsolve install again.";
  const claudePath = resolveClaude({ platform, env, home, isFile });
  if (!claudePath) {
    problems.push(notFound);
    return result();
  }

  let version;
  try {
    version = await exec(claudePath, ["--version"], { env, timeoutMs: 30_000 });
  } catch (e) {
    problems.push(e?.code === "ENOENT" ? notFound : `cannot run ${claudePath} (${errorText(e)})`);
    return result({ claudePath });
  }
  if (version.code !== 0) {
    problems.push(`\`claude --version\` failed (${exitText(version)}): ${clip(outputOf(version)) || "(no output)"}`);
    return result({ claudePath });
  }
  const claudeVersion = version.stdout.trim();

  let status;
  try {
    status = await exec(claudePath, ["auth", "status"], { env, timeoutMs: 30_000 });
  } catch (e) {
    problems.push(`cannot run \`claude auth status\` (${errorText(e)})`);
    return result({ claudePath, claudeVersion });
  }
  // A logged-out claude exits 1 with the same JSON, so the output decides, not the exit code.
  const auth = parseObject(status.stdout);
  if (!auth) {
    problems.push(`\`claude auth status\` did not print JSON: ${clip(outputOf(status)) || "(no output)"}`);
    return result({ claudePath, claudeVersion });
  }
  if (auth.loggedIn !== true) {
    problems.push(`Claude Code is not logged in. ${LOGIN_HINT}`);
  } else if (auth.authMethod !== "claude.ai") {
    warnings.push(
      `claude is logged in with "${auth.authMethod ?? "unknown"}", not a Claude subscription: usage may bill to an API key.`,
    );
  }
  return result({ claudePath, claudeVersion, auth });
}

// ---------------------------------------------------------------------------------------------------------------
// Staging a version and the `current` link

/**
 * Copies the plugin's `app/` into a staging dir under `appRoot`, runs `npm ci --omit=dev --ignore-scripts` there and
 * only then moves it to `<appRoot>/<version>/`, so a failed npm leaves `current` and any existing copy of that
 * version as they were. Returns `{ version, dir }` (plus `warnings` when a replaced copy could not be removed).
 */
export async function stageVersion({ source, appRoot, platform, exec = run, rename = renameRetrying }) {
  const version = (await readJson(path.join(source, "package.json")))?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${path.join(source, "package.json")} has no valid version (got ${JSON.stringify(version)})`);
  }

  const dir = path.join(appRoot, version);
  const staging = path.join(appRoot, `.${version}-staging-${shortId()}`);
  await fsp.mkdir(appRoot, { recursive: true });
  let warnings;
  try {
    await fsp.cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    let npm;
    try {
      // npm is npm.cmd on Windows, which only a shell can run.
      npm = await exec("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
        cwd: staging,
        shell: platform === "win32",
        timeoutMs: 10 * 60_000,
      });
    } catch (e) {
      throw new Error(`cannot run npm (${errorText(e)}): is Node.js installed with npm on PATH?`);
    }
    if (npm.code !== 0) {
      throw new Error(`npm ci --omit=dev failed (${exitText(npm)}); its last lines:\n${lastLines(outputOf(npm), 10)}`);
    }
    warnings = await swapIn(staging, dir, rename);
  } catch (e) {
    await removeDir(staging);
    throw e;
  }
  return warnings.length ? { version, dir, warnings } : { version, dir };
}

/**
 * Points `<appRoot>/current` at `<appRoot>/<version>`: a junction on Windows, a symlink elsewhere. An existing link
 * is replaced; a real directory or file there is never deleted (error instead).
 */
export async function pointCurrent({ appRoot, version, platform, fs = fsp }) {
  const p = pathFor(platform);
  const target = p.join(appRoot, version);
  const link = p.join(appRoot, "current");

  let installed = false;
  try {
    installed = (await fs.stat(target)).isDirectory();
  } catch {
    installed = false;
  }
  if (!installed) throw new Error(`cannot point current at ${target}: version ${version} is not staged`);

  let existing = null;
  try {
    existing = await fs.lstat(link);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${link} is a real directory or file, not a link; nothing was deleted. Move it away and install again.`);
  }
  if (existing) await fs.unlink(link);
  await fs.symlink(target, link, platform === "win32" ? "junction" : "dir");
}

// ---------------------------------------------------------------------------------------------------------------
// The packaged launcher

/** `@electron/packager` from the staged version's own node_modules (installed by `npm ci --omit=dev`). */
export async function loadPackager(versionDir) {
  const require = createRequire(path.join(versionDir, "package.json"));
  const mod = await import(pathToFileURL(require.resolve("@electron/packager")).href);
  const packager = mod.packager ?? mod.default;
  if (typeof packager !== "function") throw new Error(`@electron/packager in ${versionDir} exports no packager function`);
  return packager;
}

/**
 * DESIGN §4.2 step 3: packages `<versionDir>/bootstrap` with the Electron version pinned in the app's package.json
 * and replaces `programs` with the result (the previous launcher is kept if that fails). Windows: `programs` is
 * `Programs\snapsolve`, then the Start-menu shortcut is written. macOS: `programs` is `~/Applications/snapsolve.app`
 * (LSUIElement, no Dock icon), ad-hoc signed once here — only ever when the launcher is (re)packaged, since every
 * signature is a new identity for the Screen Recording grant (DESIGN §4.1). Returns `{ exe }` (plus `warnings` when
 * the previous launcher could not be removed; `rm` is the removal, injectable for tests).
 */
export async function packageBootstrap({
  versionDir,
  programs,
  shortcut,
  platform,
  exec = run,
  loadPackager: load = loadPackager,
  rename = renameRetrying,
  rm = fsp.rm,
}) {
  if (platform !== "win32" && platform !== "darwin") throw new Error(`packaging the launcher on ${platform} is not supported`);
  const mac = platform === "darwin";

  const pkg = await readJson(path.join(versionDir, "package.json"));
  const electron = pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron;
  if (typeof electron !== "string" || !/^\d+\.\d+\.\d+$/.test(electron)) {
    throw new Error(`app/package.json must pin electron to an exact version (got ${JSON.stringify(electron) ?? "none"})`);
  }

  const options = {
    dir: path.join(versionDir, "bootstrap"),
    name: APP_DIR,
    appBundleId: "com.snapsolve.app",
    electronVersion: electron,
    overwrite: true,
  };
  if (mac) Object.assign(options, { platform: "darwin", extendInfo: { LSUIElement: true } });
  const icon = path.join(versionDir, "assets", mac ? "icon.icns" : "icon.ico");
  if (await exists(icon)) options.icon = icon;

  const parent = path.dirname(programs);
  await fsp.mkdir(parent, { recursive: true });
  options.out = path.join(parent, `.${APP_DIR}-packaging-${shortId()}`);
  // What the packager's output dir must contain, and what replaces `programs`.
  const product = mac ? `${APP_DIR}.app` : `${APP_DIR}.exe`;
  let warnings;
  try {
    const packager = await load(versionDir);
    const built = await packager(options);
    const appDir = Array.isArray(built) ? built[0] : undefined;
    if (!appDir || !(await exists(path.join(appDir, product)))) {
      throw new Error(`@electron/packager produced no ${product} (output: ${JSON.stringify(built)})`);
    }
    warnings = await swapIn(mac ? path.join(appDir, product) : appDir, programs, rename, rm);
  } finally {
    await removeDir(options.out, rm);
  }
  const withWarnings = (result) => (warnings.length ? { ...result, warnings } : result);

  if (mac) {
    await codesign(programs, exec);
    return withWarnings({ exe: path.join(programs, "Contents", "MacOS", APP_DIR) });
  }

  const exe = path.join(programs, `${APP_DIR}.exe`);
  await fsp.mkdir(path.dirname(shortcut), { recursive: true });
  const script = shortcutScript({ shortcut, target: exe, workingDirectory: programs });
  let made;
  try {
    made = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], {
      timeoutMs: 60_000,
    });
  } catch (e) {
    throw new Error(`cannot create the Start-menu shortcut: powershell.exe did not start (${errorText(e)})`);
  }
  if (made.code !== 0) {
    throw new Error(`cannot create the Start-menu shortcut ${shortcut} (${exitText(made)}): ${clip(outputOf(made)) || "(no output)"}`);
  }
  return withWarnings({ exe });
}

/**
 * PowerShell that writes a `.lnk` via WScript.Shell. Every path is a single-quoted literal (nothing expands); the
 * quote characters PowerShell accepts, including the typographic ones, are doubled.
 */
export function shortcutScript({ shortcut, target, workingDirectory }) {
  const literal = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${literal(shortcut)})`,
    `$link.TargetPath = ${literal(target)}`,
    `$link.WorkingDirectory = ${literal(workingDirectory)}`,
    "$link.Save()",
  ].join("\n");
}

/** `codesign --force --deep --sign - <bundle>` (ad-hoc; DESIGN §4.2 step 3). */
async function codesign(bundle, exec) {
  let signed;
  try {
    signed = await exec("codesign", ["--force", "--deep", "--sign", "-", bundle], { timeoutMs: 120_000 });
  } catch (e) {
    throw new Error(`codesign did not start (${errorText(e)}): are the Xcode command line tools installed?`);
  }
  if (signed.code !== 0) throw new Error(`codesign ${bundle} failed (${exitText(signed)}): ${clip(outputOf(signed)) || "(no output)"}`);
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// ---------------------------------------------------------------------------------------------------------------
// config.json

/**
 * DESIGN §4.2 step 4: `claudePath` = realpath of the resolved claude on Windows. On macOS it is the resolved path
 * itself, once realpath confirms it resolves: the native installer's `~/.local/bin/claude` is a symlink into a
 * version dir that Claude Code's auto-updates prune, so pinning the target would break after an update. A missing config.json gets the app's full
 * defaults; an existing one changes only `claudePath` (atomic temp + rename); one that is not a JSON object is left
 * byte for byte, with a warning saying what to set by hand. Returns `{ claudePath, warning }`.
 */
export async function writeClaudePath({
  configFile,
  claudePath,
  platform = "win32",
  realpath = fsp.realpath,
  rename = renameRetrying,
}) {
  let real;
  try {
    real = await realpath(claudePath);
  } catch (e) {
    throw new Error(`claude not found at ${claudePath} (${errorText(e)})`);
  }
  if (platform === "darwin") real = claudePath;

  let text = null;
  try {
    text = await fsp.readFile(configFile, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw new Error(`cannot read ${configFile} (${errorText(e)})`);
  }

  let config;
  if (text === null) {
    config = { ...defaultConfig(), claudePath: real };
  } else {
    const parsed = parseObject(text.replace(/^﻿/, ""));
    if (!parsed) {
      return {
        claudePath: real,
        warning: `${configFile} is not a JSON object, so it was left as it is; set "claudePath" to ${real} by hand.`,
      };
    }
    config = { ...parsed, claudePath: real };
  }

  await fsp.mkdir(path.dirname(configFile), { recursive: true });
  const temp = `${configFile}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`);
    await rename(temp, configFile);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
  return { claudePath: real, warning: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Running the app

/**
 * Starts the app detached, as if from the Start menu / Finder: no stdio, and none of the Claude Code session
 * variables (`CLAUDECODE*`, `CLAUDE_CODE_*`) the installer inherits. macOS goes through `open -a <bundle>` (DESIGN
 * §4.2 step 6), so the app runs under LaunchServices with its own identity. Resolves once started; rejects on a
 * spawn error.
 */
export function launch({ exe, args = [], env = process.env, spawn = nodeSpawn, platform = "win32" }) {
  let command = exe;
  let commandArgs = args;
  if (platform === "darwin") {
    const bundle = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1];
    if (!bundle) return Promise.reject(new Error(`${exe} is not the binary inside an .app bundle`));
    command = "open";
    commandArgs = ["-a", bundle, ...(args.length ? ["--args", ...args] : [])];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { detached: true, stdio: "ignore", env: appEnv(env) });
    child.once("error", (e) => reject(new Error(`cannot start ${exe} (${errorText(e)})`, { cause: e })));
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

function appEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("CLAUDECODE") || upper.startsWith("CLAUDE_CODE_")) continue;
    out[name] = value;
  }
  return out;
}

/**
 * True when a process with this image name runs: Windows `tasklist`; macOS `pgrep -x` (exact process name, so the
 * "snapsolve Helper" processes do not count; exit 1 = none).
 */
export async function processRunning({ image, exec = run, platform = "win32" }) {
  if (platform === "darwin") {
    const r = await exec("pgrep", ["-x", image], { timeoutMs: 30_000 });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new Error(`pgrep failed (${exitText(r)}): ${clip(outputOf(r)) || "(no output)"}`);
  }
  const r = await exec("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`tasklist failed (${exitText(r)}): ${clip(outputOf(r)) || "(no output)"}`);
  return r.stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

/**
 * DESIGN §4.3: when the app runs, `<exe> --quit` and poll until it is gone, up to `timeoutMs`; then an error naming
 * the exe. Does nothing (and starts nothing) when it is not running.
 */
export async function quitAndWait({
  exe,
  exec = run,
  platform = "win32",
  isRunning = () => processRunning({ image: pathFor(platform).basename(exe), exec, platform }),
  now = Date.now,
  sleep = delay,
  timeoutMs = 5000,
  pollMs = 200,
}) {
  if (!(await isRunning())) return;
  await exec(exe, ["--quit"], { timeoutMs });
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!(await isRunning())) return;
    if (now() >= deadline) {
      throw new Error(`${exe} is still running ${timeoutMs / 1000} s after --quit; quit snapsolve from its tray icon and try again.`);
    }
    await sleep(pollMs);
  }
}

/**
 * DESIGN §10 risk 6 (Detect): runs `<exe> --smoke`. `blocked` = the spawn was denied (EPERM, Defender ASR);
 * `ok` = exit 0 with the smoke line; anything else is `failed`, with the output.
 */
export async function asrCheck({ exe, exec = run, timeoutMs = 60_000 }) {
  let r;
  try {
    r = await exec(exe, ["--smoke"], { timeoutMs });
  } catch (e) {
    if (e?.code === "EPERM") return { status: "blocked", output: `spawn EPERM: ${exe}` };
    return { status: "failed", output: `cannot start ${exe} (${errorText(e)})` };
  }
  const output = outputOf(r);
  if (r.timedOut) return { status: "failed", output: `no answer within ${timeoutMs / 1000} s${output ? `: ${output}` : ""}` };
  if (r.code === 0 && /snapsolve smoke ok/.test(r.stdout)) return { status: "ok", output };
  return { status: "failed", output: `${exitText(r)}: ${output || "(no output)"}` };
}

// ---------------------------------------------------------------------------------------------------------------
// The default exec and small helpers

/**
 * Runs a command and collects its output: `{ code, signal, stdout, stderr, timedOut }`. Rejects only when it cannot
 * start (the error keeps its `code`). With `shell`, the command line is joined unquoted, so arguments must be
 * shell-safe constants.
 */
export function run(command, args = [], { cwd, env = process.env, shell = false, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const options = { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
    let child;
    try {
      child = shell ? nodeSpawn([command, ...args].join(" "), { ...options, shell: true }) : nodeSpawn(command, args, options);
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** `rename`, retried on a transient Windows code; any other code, or the last try's, is thrown. */
export async function renameRetrying(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (i >= RENAME_DELAYS_MS.length || !TRANSIENT_RENAME.has(e?.code)) throw e;
      await delay(RENAME_DELAYS_MS[i]);
    }
  }
}

/**
 * Moves `from` to `dest`; an existing `dest` is moved aside first and put back if the move fails. Returns warnings
 * (the moved-aside copy could not be removed).
 */
async function swapIn(from, dest, rename, rm = fsp.rm) {
  const old = path.join(path.dirname(dest), `.${path.basename(dest)}-old-${shortId()}`);
  const hadOld = await exists(dest);
  if (hadOld) await rename(dest, old);
  try {
    await rename(from, dest);
  } catch (e) {
    if (hadOld) {
      try {
        await rename(old, dest);
      } catch {
        throw new Error(`could not replace ${dest} (${errorText(e)}); the previous copy is kept at ${old}`, { cause: e });
      }
    }
    throw e;
  }
  if (hadOld && !(await removeDir(old, rm))) return [`could not remove the previous copy at ${old}; delete it by hand`];
  return [];
}

async function removeDir(dir, rm = fsp.rm) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/** Whether `file` exists, following links: a dangling link does not count. */
export async function exists(file) {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Whether there is anything at `file`, the link itself included: a dangling link counts (removal targets). */
export async function linkExists(file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}

function isFileSync(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The parsed JSON in `file` (a UTF-8 BOM allowed); undefined when it is missing or not JSON. */
export async function readJson(file) {
  try {
    return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * SemVer precedence of two versions (an optional leading `v` allowed): -1 / 0 / 1, null when either is not a
 * version. A pre-release sorts below its release; its identifiers compare numerically when both are digits, else
 * lexically, digits before letters; build metadata is ignored. Shared by preflight, doctor and update (task 044).
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = typeof v === "string" ? SEMVER.exec(v.trim()) : null;
    return m ? { core: m.slice(1, 4).map(Number), pre: m[4] === undefined ? [] : m[4].split(".") } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = comparePrerelease(x.pre[i], y.pre[i]);
    if (order !== 0) return order;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

function comparePrerelease(a, b) {
  const numeric = (s) => /^\d+$/.test(s);
  if (numeric(a) && numeric(b)) return Math.sign(Number(a) - Number(b));
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function outputOf(r) {
  return [r.stdout, r.stderr].map((s) => (s ?? "").trim()).filter(Boolean).join("\n");
}

function lastLines(text, n) {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-n).join("\n");
}

function clip(text, max = 500) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function exitText(r) {
  if (r.timedOut) return "timed out";
  return r.code === null ? `killed by ${r.signal}` : `exit ${r.code}`;
}

function errorText(e) {
  return e?.code ?? (e instanceof Error ? e.message : String(e));
}

function shortId() {
  return randomUUID().slice(0, 8);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
