// The packaged launcher (SPEC §8.1, DESIGN §4.1): runs `<data>/app/current/main.js`, so code updates swap that
// folder and never rebuild or re-sign the packaged app. Node built-ins and electron only — nothing is installed
// next to this file. The data-dir rules mirror src/main/paths.ts (test/unit/boot.test.ts keeps them in step).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = "snapsolve";

/** Same rules as `resolveDataDir` in src/main/paths.ts; throws instead of guessing. */
function resolveDataDir(platform, env, home) {
  const p = platform === "win32" ? path.win32 : path.posix;

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

/** `<data>/app/current/main.js` for this platform. */
function resolveEntry(platform, env, home) {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(resolveDataDir(platform, env, home), "app", "current", "main.js");
}

/** Loads the installed app, or shows why it can't and exits 1. */
function boot({ resolve, exists, load, showError, exit }) {
  const fail = (content) => {
    showError("snapsolve can't start", content);
    exit(1);
  };
  let entry;
  try {
    entry = resolve();
  } catch (e) {
    return fail(`${message(e)}\n\nRun /snapsolve install in Claude Code.`);
  }
  if (!exists(entry)) {
    return fail(`snapsolve is not installed correctly: ${entry} is missing.\n\nRun /snapsolve install in Claude Code.`);
  }
  try {
    load(entry);
  } catch (e) {
    fail(`snapsolve failed to load ${entry}:\n${message(e)}\n\nRun /snapsolve install in Claude Code to repair it.`);
  }
}

function message(e) {
  return e instanceof Error ? e.message : String(e);
}

module.exports = { resolveEntry, boot };

// Only as Electron's main module; loading this file anywhere else (tests) does nothing.
if (require.main === module && process.versions.electron) {
  const { app, dialog } = require("electron");
  boot({
    resolve: () => resolveEntry(process.platform, process.env, os.homedir()),
    exists: (file) => fs.existsSync(file),
    load: (file) => require(file),
    showError: (title, content) => dialog.showErrorBox(title, content),
    exit: (code) => app.exit(code),
  });
}
