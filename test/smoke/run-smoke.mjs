// Smoke test for task 001: build, then launch the app with --smoke and check its output,
// the build outputs, the exact electron pin, and that the build leaves no untracked files.
// Usage: node test/smoke/run-smoke.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIMEOUT_MS = 60_000;
const ELECTRON_VERSION = "44.7.2";
const BUILD_OUTPUTS = [
  "dist/main.js",
  "dist/preload.js",
  "dist/renderer/index.html",
  "dist/renderer/renderer.js",
  "dist/renderer/styles.css",
];

function fail(msg) {
  console.error(`run-smoke: FAIL — ${msg}`);
  process.exit(1);
}

function gitStatus() {
  const r = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) fail(`git status failed: ${r.stderr}`);
  return new Set(r.stdout.split(/\r?\n/).filter(Boolean));
}

const pkgPath = path.join(root, "package.json");
if (!existsSync(pkgPath)) fail("package.json not found at the repo root");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;

const pinned = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
if (pinned !== ELECTRON_VERSION) fail(`electron must be pinned exactly to ${ELECTRON_VERSION} in package.json, got ${pinned}`);

// Start from no dist/ so a stale build cannot hide outputs that git would show.
rmSync(path.join(root, "dist"), { recursive: true, force: true });
const statusBefore = gitStatus();

const build = spawnSync("npm run build", { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) fail(`npm run build exited with ${build.status}`);

for (const rel of BUILD_OUTPUTS) {
  if (!existsSync(path.join(root, rel))) fail(`${rel} missing after build`);
  const ignored = spawnSync("git", ["check-ignore", "-q", rel], { cwd: root });
  if (ignored.status !== 0) fail(`${rel} is not ignored by git`);
}
const mainJs = path.join(root, "dist", "main.js");

const require = createRequire(pkgPath);
let installed;
try {
  installed = require("electron/package.json").version;
} catch {
  fail("electron is not installed (run npm install)");
}
if (installed !== ELECTRON_VERSION) fail(`installed electron is ${installed}, expected ${ELECTRON_VERSION}`);

let electronPath;
try {
  electronPath = require("electron");
} catch {
  fail("electron binary path could not be resolved");
}
if (typeof electronPath !== "string" || !existsSync(electronPath)) fail("electron binary not found");

const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-smoke-"));
const env = { ...process.env, SNAPSOLVE_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [mainJs, "--smoke"], { cwd: root, env, windowsHide: true });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const timer = setTimeout(() => {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  fail(`timed out after ${TIMEOUT_MS / 1000} s; output:\n${out}`);
}, TIMEOUT_MS);

child.on("close", (code) => {
  clearTimeout(timer);
  rmSync(dataDir, { recursive: true, force: true });
  const expected = `snapsolve smoke ok ${version}`;
  if (code !== 0) fail(`app exited with ${code}; output:\n${out}`);
  if (!out.split(/\r?\n/).some((l) => l.trim() === expected)) {
    fail(`expected a line "${expected}"; output:\n${out}`);
  }
  const added = [...gitStatus()].filter((l) => !statusBefore.has(l));
  if (added.length) fail(`build/smoke left files git does not ignore:\n${added.join("\n")}`);
  console.log(`run-smoke: PASS — ${expected}`);
});
