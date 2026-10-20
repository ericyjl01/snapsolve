// Release (SPEC §8.1, DESIGN §4–5): assembles the snapsolve plugin into a claude-skills marketplace folder — the
// plugin manifest and skill from plugin/, plus app/: the built app, prompts, assets, the bootstrap launcher and the
// package.json + lockfile the installer runs `npm ci --omit=dev` on. Adds the marketplace entry and README row once.
// Usage: node scripts/release.mjs [--target <marketplace root>]   (builds first)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const NAME = "snapsolve";
const TEXT_FILE = /\.(md|mjs|cjs|js|json|html|css|txt)$/i;
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
// Defender and the indexer briefly hold freshly written files (docs/issues.md, task 006); a directory of ~80 new
// files can stay locked longer than store.ts's 200 ms, and a release is not latency-sensitive.
const RENAME_DELAYS_MS = [20, 50, 100, 200, 400, 800, 1000, 1000];

/** `--target <dir>` or Eric's claude-setup-source copy of claude-skills. */
export function parseArgs(argv, home = os.homedir()) {
  let target = path.join(home, ".claude", "claude-setup-source", "plugins", "claude-skills");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--target") throw new Error(`unknown argument: ${argv[i]}`);
    const value = argv[++i];
    if (!value) throw new Error("--target needs a directory");
    target = path.resolve(value);
  }
  return { target };
}

/** `rename`, retried on a transient code; any other code, or the last try's, is thrown. */
export function renameRetrying(from, to, { rename = renameSync, sleep = sleepSync } = {}) {
  for (let i = 0; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (i >= RENAME_DELAYS_MS.length || !TRANSIENT_RENAME.has(e?.code)) throw e;
      sleep(RENAME_DELAYS_MS[i]);
    }
  }
}

/**
 * Writes `<target>/plugins/snapsolve/` from an already-built repo at `root`. Everything is checked before the
 * first write, so a refusal leaves the target as it was; a failed swap puts the previous release back.
 * Returns whether anything changed and any warnings. `rename` is injectable for tests.
 */
export function assemble({ root, target, rename = renameRetrying }) {
  const marketplaceFile = path.join(target, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplaceFile)) throw new Error(`${target} is not a marketplace: .claude-plugin/marketplace.json is missing`);
  if (!existsSync(path.join(root, "dist", "main.js"))) throw new Error("dist/main.js is missing: run npm run build first");

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const payload = buildPayload(root, pkg);
  const dest = path.join(target, "plugins", NAME);
  const released = existsSync(dest) ? readTree(dest) : new Map();
  const releasedVersion = appVersion(released);
  if (releasedVersion === pkg.version && !treesEqual(subtree(released, "app/"), subtree(payload, "app/"))) {
    throw new Error(`${NAME} ${pkg.version} is already released with a different app/: bump the version in package.json`);
  }

  const warnings = [];
  if (!payload.has("app/native/snapsolve-speech")) {
    warnings.push("dist/native/snapsolve-speech is missing (built without swiftc): the speech helper is not released, so voice will not work");
  }
  const entry = { name: NAME, source: `./plugins/${NAME}`, description: pkg.description };
  const marketplace = addMarketplaceEntry(readFileSync(marketplaceFile, "utf8"), entry);
  const readmeFile = path.join(target, "README.md");
  let readme = null;
  if (existsSync(readmeFile)) {
    const result = addReadmeRow(readFileSync(readmeFile, "utf8"));
    readme = result.text;
    if (result.warning) warnings.push(result.warning);
  } else {
    warnings.push("README.md not found in the marketplace; add a snapsolve row by hand");
  }

  const pluginChanged = !treesEqual(released, payload);
  if (pluginChanged) warnings.push(...replaceDir(dest, payload, rename));
  if (marketplace !== null) writeAtomic(marketplaceFile, marketplace, rename);
  if (readme !== null) writeAtomic(readmeFile, readme, rename);
  return { dest, version: pkg.version, changed: pluginChanged || marketplace !== null || readme !== null, warnings };
}

/** Relative posix path → bytes for everything the released plugin contains. */
function buildPayload(root, pkg) {
  const out = new Map();
  const add = (rel, bytes) => out.set(rel, TEXT_FILE.test(rel) ? toLf(bytes) : bytes);
  const addDir = (dir, prefix) => {
    for (const rel of walk(dir)) add(`${prefix}${rel}`, readFileSync(path.join(dir, rel)));
  };

  addDir(path.join(root, "plugin"), "");
  const manifest = JSON.parse(out.get(".claude-plugin/plugin.json")?.toString("utf8") ?? "null");
  if (!manifest) throw new Error("plugin/.claude-plugin/plugin.json is missing");
  // No `version` (claude-skills convention, DECISIONS 2026-10-14 / 027): a pinned version would hold marketplace
  // users on their cached copy; the app version lives in app/package.json.
  const { version: _version, ...released } = manifest;
  add(".claude-plugin/plugin.json", json(released));

  const dist = path.join(root, "dist");
  for (const file of ["main.js", "preload.js"]) add(`app/${file}`, readFileSync(path.join(dist, file)));
  addDir(path.join(dist, "renderer"), "app/renderer/");
  // The speech helper (063); main restores its executable bit (voice.ts resolveSpeechHelper).
  addDir(path.join(dist, "native"), "app/native/");
  addDir(path.join(root, "prompts"), "app/prompts/");
  if (existsSync(path.join(root, "assets"))) addDir(path.join(root, "assets"), "app/assets/");
  addDir(path.join(root, "bootstrap"), "app/bootstrap/");

  // The staged app's manifest: same dependencies as the lockfile (npm ci needs them in step), so `npm ci --omit=dev`
  // installs @electron/packager; `main` is the bundle at the app root; build scripts would not work there.
  const { scripts: _scripts, ...appPkg } = pkg;
  add("app/package.json", json({ ...appPkg, main: "main.js" }));
  add("app/package-lock.json", readFileSync(path.join(root, "package-lock.json")));
  return out;
}

/** Files under `dir` as posix relative paths; skips dotfiles (except .claude-plugin), node_modules and source maps. */
function walk(dir, rel = "") {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if ((name.startsWith(".") && name !== ".claude-plugin") || name === "node_modules" || name.endsWith(".map")) continue;
    const full = path.join(dir, name);
    const relName = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) files.push(...walk(full, relName));
    else files.push(relName);
  }
  return files;
}

function readTree(dir) {
  const tree = new Map();
  const visit = (d, rel) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      const relName = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) visit(full, relName);
      else tree.set(relName, readFileSync(full));
    }
  };
  visit(dir, "");
  return tree;
}

function appVersion(tree) {
  try {
    return JSON.parse(tree.get("app/package.json")?.toString("utf8") ?? "null")?.version ?? null;
  } catch {
    return null;
  }
}

function subtree(tree, prefix) {
  return new Map([...tree].filter(([rel]) => rel.startsWith(prefix)));
}

function treesEqual(a, b) {
  return a.size === b.size && [...a].every(([rel, bytes]) => b.get(rel)?.equals(bytes) === true);
}

/**
 * Builds the new plugin dir beside the old one, then swaps it in. The previous release is deleted only after the
 * swap succeeded; a failed swap renames it back (or, if even that fails, says where it is). Returns warnings.
 */
function replaceDir(dest, tree, rename) {
  const parent = path.dirname(dest);
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.${NAME}-staging-${stamp}`);
  const old = path.join(parent, `.${NAME}-old-${stamp}`);
  let movedOld = false;
  try {
    for (const [rel, bytes] of tree) {
      const file = path.join(staging, ...rel.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    if (existsSync(dest)) {
      rename(dest, old);
      movedOld = true;
    }
    rename(staging, dest);
  } catch (e) {
    removeDir(staging);
    if (movedOld) {
      try {
        rename(old, dest);
      } catch {
        throw new Error(`release failed (${e.message}); the previous release is kept at ${old}`);
      }
    }
    throw e;
  }
  return removeDir(old) ? [] : [`could not remove the previous release at ${old}; delete it by hand`];
}

/** Recursive delete with Node's own retries; false if the dir is still there. */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The marketplace text with `entry` appended to `plugins`, keeping the existing text as written; null when an entry
 * of that name exists. Falls back to re-serializing when the text cannot be spliced safely.
 */
function addMarketplaceEntry(text, entry) {
  const market = JSON.parse(text);
  if (!Array.isArray(market.plugins)) throw new Error("marketplace.json has no plugins array");
  if (market.plugins.some((p) => p?.name === entry.name)) return null;
  const expected = { ...market, plugins: [...market.plugins, entry] };
  const spliced = spliceEntry(text, entry);
  if (spliced !== null && isDeepStrictEqual(tryParse(spliced), expected)) return spliced;
  return `${JSON.stringify(expected, null, 2)}\n`;
}

function spliceEntry(text, entry) {
  const key = /"plugins"\s*:\s*\[/.exec(text);
  if (!key) return null;
  const close = matchingBracket(text, key.index + key[0].length - 1);
  if (close < 0) return null;
  let last = close - 1;
  while (last > 0 && /\s/.test(text[last])) last--;
  if (text[last] !== "}") return null;
  const lineStart = text.lastIndexOf("\n", last) + 1;
  const indent = /^\s*/.exec(text.slice(lineStart))[0];
  const oneLine = `{ ${Object.entries(entry).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return `${text.slice(0, last + 1)},${eol}${indent}${oneLine}${text.slice(last + 1)}`;
}

/** Index of the `]` closing the `[` at `open`, skipping strings; -1 if unbalanced. */
function matchingBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === "]" ? i : -1;
    }
  }
  return -1;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const README_CELLS = [
  "`snapsolve`",
  "Hotkey screen capture → step-by-step answer from Claude in a side panel (Windows desktop app)",
  "`/snapsolve install`",
  "Node ≥ 22.12; installs a desktop app (`/snapsolve doctor` checks it)",
];

/** The README with a snapsolve row at the end of its plugin table; `text: null` when there is one or no table. */
function addReadmeRow(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  if (lines.some((l) => l.startsWith(`| \`${NAME}\``))) return { text: null };
  const header = lines.findIndex((l) => /^\|\s*Plugin\s*\|/.test(l));
  if (header < 0 || !/^\|[\s:|-]+$/.test(lines[header + 1]?.trim() ?? "")) {
    return { text: null, warning: "README.md has no plugin table (| Plugin | …); add a snapsolve row by hand" };
  }
  let last = header + 1;
  while (last + 1 < lines.length && lines[last + 1].startsWith("|")) last++;
  const columns = lines[header].split("|").length - 2;
  const cells = Array.from({ length: columns }, (_, i) => README_CELLS[i] ?? "");
  lines.splice(last + 1, 0, `| ${cells.join(" | ")} |`);
  return { text: lines.join(eol) };
}

function writeAtomic(file, text, rename) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    rename(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function toLf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e.message}\nusage: node scripts/release.mjs [--target <marketplace root>]`);
    process.exit(2);
  }
  console.log(`release: target ${args.target}`);
  const build = spawnSync("npm run build", { cwd: root, stdio: "inherit", shell: true });
  if (build.status !== 0) {
    console.error("release: build failed");
    process.exit(1);
  }
  try {
    const result = assemble({ root, target: args.target });
    for (const w of result.warnings) console.warn(`release: warning: ${w}`);
    console.log(result.changed ? `release: ${NAME} ${result.version} → ${result.dest}` : `release: ${result.dest} is already up to date`);
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
