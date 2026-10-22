import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asrCheck,
  compareVersions,
  dataDir,
  exists,
  installPaths,
  launch,
  linkExists,
  loadPackager,
  packageBootstrap,
  pointCurrent,
  preflight,
  processRunning,
  quitAndWait,
  readJson,
  renameRetrying,
  resolveClaude,
  run,
  shortcutScript,
  stageVersion,
  writeClaudePath,
} from "../../plugin/skills/snapsolve/scripts/steps.mjs";
import { DEFAULTS, loadConfig } from "../../src/main/config";
import { resolveDataDir } from "../../src/main/paths";
import { repoRoot } from "../paths";

type Env = Record<string, string | undefined>;
interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
interface ExecCall {
  command: string;
  args: string[];
  options: { cwd?: string; env?: Env; shell?: boolean; timeoutMs?: number };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "snapsolve-steps-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Every file under `dir` as sorted posix-style relative paths (links followed). */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn ${code}`), { code });
}

/** A fake `exec` that records calls; `handler` returns a result or throws (a spawn error). */
function fakeExec(handler: (call: ExecCall) => ExecResult | Promise<ExecResult>) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (command: string, args: string[], options: ExecCall["options"] = {}) => {
    const call = { command, args, options };
    calls.push(call);
    return handler(call);
  });
  return { exec, calls };
}

// ---------------------------------------------------------------------------------------------------------------
// data dir and install paths

describe("dataDir: the same rules as src/main/paths.ts", () => {
  const cases: Array<[NodeJS.Platform, Env, string]> = [
    ["win32", { LOCALAPPDATA: "C:\\Users\\eric\\AppData\\Local" }, "C:\\Users\\eric"],
    ["win32", { LOCALAPPDATA: "C:\\Users\\eric\\AppData\\Local", SNAPSOLVE_DATA_DIR: "D:\\data\\..\\snap" }, "C:\\Users\\eric"],
    ["darwin", {}, "/Users/eric"],
    ["darwin", { SNAPSOLVE_DATA_DIR: "/tmp/x/../snap" }, "/Users/eric"],
  ];
  for (const [platform, env, home] of cases) {
    it(`${platform} ${JSON.stringify(env)} → the app's data dir`, () => {
      expect(dataDir(platform, env, home)).toBe(resolveDataDir(platform, env, home));
    });
  }

  const failures: Array<[NodeJS.Platform, Env, string]> = [
    ["win32", {}, "C:\\Users\\eric"],
    ["win32", { LOCALAPPDATA: "relative\\Local" }, "C:\\Users\\eric"],
    ["darwin", {}, ""],
    ["linux", {}, "/home/eric"],
    ["darwin", { SNAPSOLVE_DATA_DIR: "relative/snap" }, "/Users/eric"],
  ];
  for (const [platform, env, home] of failures) {
    it(`${platform} ${JSON.stringify(env)} home "${home}" → throws, like the app`, () => {
      expect(() => resolveDataDir(platform, env, home)).toThrow();
      expect(() => dataDir(platform, env, home)).toThrow();
    });
  }
});

describe("installPaths (win32)", () => {
  it("puts the app under the data dir, the exe under Programs and the shortcut in the Start menu", () => {
    const p = installPaths({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\eric\\AppData\\Local", APPDATA: "C:\\Users\\eric\\AppData\\Roaming" },
      home: "C:\\Users\\eric",
    });
    expect(p).toEqual({
      data: "C:\\Users\\eric\\AppData\\Local\\snapsolve",
      appRoot: "C:\\Users\\eric\\AppData\\Local\\snapsolve\\app",
      current: "C:\\Users\\eric\\AppData\\Local\\snapsolve\\app\\current",
      config: "C:\\Users\\eric\\AppData\\Local\\snapsolve\\config.json",
      programs: "C:\\Users\\eric\\AppData\\Local\\Programs\\snapsolve",
      exe: "C:\\Users\\eric\\AppData\\Local\\Programs\\snapsolve\\snapsolve.exe",
      shortcut: "C:\\Users\\eric\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\snapsolve.lnk",
    });
  });

  it("APPDATA missing or relative → throws instead of guessing", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\eric\\AppData\\Local" };
    expect(() => installPaths({ platform: "win32", env, home: "C:\\Users\\eric" })).toThrow(/APPDATA/);
    expect(() => installPaths({ platform: "win32", env: { ...env, APPDATA: "Roaming" }, home: "C:\\Users\\eric" })).toThrow(
      /APPDATA/,
    );
  });
});

describe("installPaths (darwin)", () => {
  it("puts the app under Application Support and the launcher bundle in ~/Applications; no shortcut", () => {
    expect(installPaths({ platform: "darwin", env: {}, home: "/Users/eric" })).toEqual({
      data: "/Users/eric/Library/Application Support/snapsolve",
      appRoot: "/Users/eric/Library/Application Support/snapsolve/app",
      current: "/Users/eric/Library/Application Support/snapsolve/app/current",
      config: "/Users/eric/Library/Application Support/snapsolve/config.json",
      programs: "/Users/eric/Applications/snapsolve.app",
      exe: "/Users/eric/Applications/snapsolve.app/Contents/MacOS/snapsolve",
      shortcut: null,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// preflight

const WIN_HOME = "C:\\Users\\eric";
const LOCAL_CLAUDE = "C:\\Users\\eric\\.local\\bin\\claude.exe";
const AUTH = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team" };

describe("resolveClaude", () => {
  it("win32: the first claude.exe on PATH wins", () => {
    const env = { PATH: "C:\\Windows\\system32;C:\\tools;C:\\other" };
    const isFile = (p: string) => p === "C:\\tools\\claude.exe" || p === "C:\\other\\claude.exe" || p === LOCAL_CLAUDE;
    expect(resolveClaude({ platform: "win32", env, home: WIN_HOME, isFile })).toBe("C:\\tools\\claude.exe");
  });

  it("win32: falls back to ~/.local/bin, reads Path when PATH is absent, and skips empty entries", () => {
    const isFile = (p: string) => p === LOCAL_CLAUDE;
    expect(resolveClaude({ platform: "win32", env: { Path: ";C:\\tools;" }, home: WIN_HOME, isFile })).toBe(LOCAL_CLAUDE);
  });

  it("win32: a claude.cmd shim alone does not count (the app spawns without a shell)", () => {
    const isFile = (p: string) => p === "C:\\npm\\claude.cmd" || p === "C:\\npm\\claude";
    expect(resolveClaude({ platform: "win32", env: { PATH: "C:\\npm" }, home: WIN_HOME, isFile })).toBeNull();
  });

  it("darwin: `claude` on a colon-separated PATH, then ~/.local/bin", () => {
    const env = { PATH: "/usr/bin:/opt/homebrew/bin" };
    expect(resolveClaude({ platform: "darwin", env, home: "/Users/eric", isFile: (p: string) => p === "/opt/homebrew/bin/claude" })).toBe(
      "/opt/homebrew/bin/claude",
    );
    expect(
      resolveClaude({ platform: "darwin", env, home: "/Users/eric", isFile: (p: string) => p === "/Users/eric/.local/bin/claude" }),
    ).toBe("/Users/eric/.local/bin/claude");
  });
});

function preflightDeps(over: Record<string, unknown> = {}) {
  const { exec, calls } = fakeExec(({ args }) =>
    args[0] === "--version" ? ok("2.1.300 (Claude Code)\n") : ok(`${JSON.stringify(AUTH, null, 2)}\n`),
  );
  return {
    calls,
    deps: {
      platform: "win32",
      nodeVersion: "v22.12.0",
      env: { PATH: "C:\\Windows\\system32" },
      home: WIN_HOME,
      isFile: (p: string) => p === LOCAL_CLAUDE,
      exec,
      ...over,
    },
  };
}

describe("preflight", () => {
  it("win32 + Node 22.12.0 + logged-in claude → ok, with the claude path, version and auth", async () => {
    const { deps, calls } = preflightDeps();
    const r = await preflight(deps);
    expect(r).toMatchObject({ ok: true, problems: [], warnings: [], claudePath: LOCAL_CLAUDE, claudeVersion: "2.1.300 (Claude Code)" });
    expect(r.auth).toMatchObject({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" });
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      [LOCAL_CLAUDE, ["--version"]],
      [LOCAL_CLAUDE, ["auth", "status"]],
    ]);
  });

  it("newer Node versions pass", async () => {
    for (const nodeVersion of ["v22.12.1", "v22.20.0", "v23.0.0", "v24.19.0"]) {
      expect((await preflight(preflightDeps({ nodeVersion }).deps)).ok, nodeVersion).toBe(true);
    }
  });

  // M3 (task 031): macOS is supported; this replaces 023's "darwin → M3 message" check.
  it("darwin + Node 22.12.0 + logged-in claude → ok, claude found on a colon-separated PATH", async () => {
    const mac = "/opt/homebrew/bin/claude";
    const { deps, calls } = preflightDeps({
      platform: "darwin",
      home: "/Users/eric",
      env: { PATH: "/usr/bin:/opt/homebrew/bin" },
      isFile: (p: string) => p === mac,
    });
    const r = await preflight(deps);
    expect(r).toMatchObject({ ok: true, problems: [], claudePath: mac });
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      [mac, ["--version"]],
      [mac, ["auth", "status"]],
    ]);
  });

  it("darwin with an old Node → fails with the brew hint", async () => {
    const isFile = (p: string) => p === "/Users/eric/.local/bin/claude";
    const r = await preflight(preflightDeps({ platform: "darwin", home: "/Users/eric", nodeVersion: "v20.18.1", isFile }).deps);
    expect(r.ok).toBe(false);
    const problem = r.problems.find((p: string) => p.includes("Node"));
    expect(problem).toContain("brew install node");
    expect(problem).not.toContain("winget");
  });

  it("linux → unsupported, nothing run", async () => {
    const { deps, calls } = preflightDeps({ platform: "linux", home: "/home/eric" });
    const r = await preflight(deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/linux is not supported/)]);
    expect(calls).toEqual([]);
  });

  for (const nodeVersion of ["v22.11.0", "v20.18.1", "v18.20.4"]) {
    it(`Node ${nodeVersion} → fails with the 22.12 minimum and the winget hint`, async () => {
      const r = await preflight(preflightDeps({ nodeVersion }).deps);
      expect(r.ok).toBe(false);
      const problem = r.problems.find((p: string) => p.includes("Node"));
      expect(problem).toContain(nodeVersion);
      expect(problem).toContain("22.12");
      expect(problem).toContain("winget install OpenJS.NodeJS.LTS");
    });
  }

  it("Node too old and claude missing → both problems reported", async () => {
    const r = await preflight(preflightDeps({ nodeVersion: "v20.0.0", isFile: () => false }).deps);
    expect(r.problems).toHaveLength(2);
  });

  it("no claude.exe on PATH or in ~/.local/bin → fails naming Claude Code, runs nothing", async () => {
    const { deps, calls } = preflightDeps({ isFile: () => false });
    const r = await preflight(deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/Claude Code not found/)]);
    expect(calls).toEqual([]);
  });

  it("claude found but spawning it fails with ENOENT → fails naming Claude Code", async () => {
    const { exec } = fakeExec(() => {
      throw spawnError("ENOENT");
    });
    const r = await preflight(preflightDeps({ exec }).deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/Claude Code not found/)]);
  });

  it("claude --version exits non-zero → fails quoting its output", async () => {
    const { exec } = fakeExec(() => ({ code: 2, stdout: "", stderr: "corrupt install\n" }));
    const r = await preflight(preflightDeps({ exec }).deps);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("corrupt install");
  });

  it("loggedIn: false → fails with the login hint", async () => {
    const { exec } = fakeExec(({ args }) =>
      args[0] === "--version" ? ok("2.1.300 (Claude Code)") : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" },
    );
    const r = await preflight(preflightDeps({ exec }).deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringContaining("Run `claude` once and log in.")]);
  });

  it("an API-key authMethod → ok, plus a billing warning", async () => {
    const { exec } = fakeExec(({ args }) =>
      args[0] === "--version" ? ok("2.1.300 (Claude Code)") : ok(JSON.stringify({ ...AUTH, authMethod: "api_key" })),
    );
    const r = await preflight(preflightDeps({ exec }).deps);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.stringMatching(/API key/)]);
    expect(r.warnings[0]).toMatch(/bill/);
    expect(r.warnings[0]).toContain("api_key");
  });

  it("auth status output that is not JSON → fails, quoting the output", async () => {
    const { exec } = fakeExec(({ args }) =>
      args[0] === "--version" ? ok("2.1.300 (Claude Code)") : { code: 1, stdout: "", stderr: "error: unknown command 'auth'\n" },
    );
    const r = await preflight(preflightDeps({ exec }).deps);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("error: unknown command 'auth'");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// stageVersion and pointCurrent

const PAYLOAD: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "snapsolve", version: "0.2.0", main: "main.js" }, null, 2)}\n`,
  "package-lock.json": "{}\n",
  "main.js": "// main 0.2.0\n",
  "preload.js": "// preload\n",
  "renderer/index.html": "<!doctype html>\n",
  "prompts/system.md": "Solve it.\n",
  "bootstrap/boot.js": "// boot\n",
  "bootstrap/package.json": '{ "name": "snapsolve", "main": "boot.js" }\n',
};

function makePayload(dir: string, payload = PAYLOAD): void {
  for (const [rel, content] of Object.entries(payload)) write(path.join(dir, ...rel.split("/")), content);
}

describe("stageVersion", () => {
  let source: string;
  let appRoot: string;

  beforeEach(() => {
    source = path.join(tmp, "plugin", "app");
    appRoot = path.join(tmp, "data", "app");
    makePayload(source);
  });

  it("copies every payload file to <appRoot>/<version>/ and runs npm ci --omit=dev there", async () => {
    let seenAtNpm: string[] = [];
    const { exec, calls } = fakeExec(({ options }) => {
      seenAtNpm = files(options.cwd!);
      write(path.join(options.cwd!, "node_modules", "x", "index.js"), "// installed\n");
      return ok("added 61 packages\n");
    });
    const r = await stageVersion({ source, appRoot, platform: "win32", exec });

    const dir = path.join(appRoot, "0.2.0");
    expect(r).toEqual({ version: "0.2.0", dir });
    expect(seenAtNpm).toEqual(Object.keys(PAYLOAD).sort());
    expect(files(dir)).toEqual([...Object.keys(PAYLOAD), "node_modules/x/index.js"].sort());
    expect(readFileSync(path.join(dir, "main.js"), "utf8")).toBe("// main 0.2.0\n");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm");
    expect(calls[0].args).toEqual(["ci", "--omit=dev", "--ignore-scripts"]);
    expect(path.dirname(calls[0].options.cwd!)).toBe(appRoot);
    expect(calls[0].options.shell).toBe(true);
    expect(readdirSync(appRoot)).toEqual(["0.2.0"]);
  });

  it("darwin runs npm without a shell", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await stageVersion({ source, appRoot, platform: "darwin", exec });
    expect(calls[0].options.shell).toBe(false);
  });

  it("npm failure → error with npm's last lines, the new version dir removed, current still on the previous version", async () => {
    makePayload(path.join(appRoot, "0.1.0"), { "main.js": "// main 0.1.0\n" });
    await pointCurrent({ appRoot, version: "0.1.0", platform: process.platform });
    const output = Array.from({ length: 30 }, (_, i) => `npm-out-${String(i + 1).padStart(2, "0")}`).join("\n");
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: `${output}\n` }));

    const error = await stageVersion({ source, appRoot, platform: "win32", exec }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("npm ci");
    expect(error.message).toContain("npm-out-21");
    expect(error.message).toContain("npm-out-30");
    expect(error.message).not.toContain("npm-out-20");
    expect(readdirSync(appRoot).sort()).toEqual(["0.1.0", "current"]);
    expect(readFileSync(path.join(appRoot, "current", "main.js"), "utf8")).toBe("// main 0.1.0\n");
  });

  it("npm cannot be started → error naming npm, nothing left behind", async () => {
    const { exec } = fakeExec(() => {
      throw spawnError("ENOENT");
    });
    await expect(stageVersion({ source, appRoot, platform: "win32", exec })).rejects.toThrow(/npm/);
    expect(existsSync(appRoot) ? readdirSync(appRoot) : []).toEqual([]);
  });

  it("the same version already staged → replaced on success, kept as it was on failure", async () => {
    makePayload(path.join(appRoot, "0.2.0"), { "main.js": "// old build\n", "stale.js": "// stale\n" });

    const failing = fakeExec(() => ({ code: 1, stdout: "", stderr: "ERR!\n" }));
    await expect(stageVersion({ source, appRoot, platform: "win32", exec: failing.exec })).rejects.toThrow(/ERR!/);
    expect(files(path.join(appRoot, "0.2.0"))).toEqual(["main.js", "stale.js"]);
    expect(readdirSync(appRoot)).toEqual(["0.2.0"]);

    const passing = fakeExec(() => ok());
    await stageVersion({ source, appRoot, platform: "win32", exec: passing.exec });
    expect(files(path.join(appRoot, "0.2.0"))).toEqual(Object.keys(PAYLOAD).sort());
    expect(readdirSync(appRoot)).toEqual(["0.2.0"]);
  });

  it("moving the staged copy into place fails → the previous copy of that version is put back, nothing left over", async () => {
    makePayload(path.join(appRoot, "0.2.0"), { "main.js": "// old build\n" });
    const { exec } = fakeExec(() => ok());
    const { rename: realRename } = await import("node:fs/promises");
    const rename = vi.fn(async (from: string, to: string) => {
      if (path.basename(from).includes("staging")) throw spawnError("EPERM");
      return realRename(from, to);
    });
    await expect(stageVersion({ source, appRoot, platform: "win32", exec, rename })).rejects.toThrow(/EPERM/);
    expect(files(path.join(appRoot, "0.2.0"))).toEqual(["main.js"]);
    expect(readFileSync(path.join(appRoot, "0.2.0", "main.js"), "utf8")).toBe("// old build\n");
    expect(readdirSync(appRoot)).toEqual(["0.2.0"]);
  });

  it("a payload without a version in package.json → error, npm not run", async () => {
    write(path.join(source, "package.json"), '{ "name": "snapsolve" }\n');
    const { exec, calls } = fakeExec(() => ok());
    await expect(stageVersion({ source, appRoot, platform: "win32", exec })).rejects.toThrow(/version/);
    expect(calls).toEqual([]);
  });
});

describe("pointCurrent (real links on this machine)", () => {
  let appRoot: string;

  beforeEach(() => {
    appRoot = path.join(tmp, "data", "app");
    makePayload(path.join(appRoot, "0.1.0"), { "main.js": "// v1\n" });
    makePayload(path.join(appRoot, "0.2.0"), { "main.js": "// v2\n" });
  });

  it("a new install creates current as a link (a junction on Windows)", async () => {
    await pointCurrent({ appRoot, version: "0.1.0", platform: process.platform });
    expect(lstatSync(path.join(appRoot, "current")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(appRoot, "current", "main.js"), "utf8")).toBe("// v1\n");
  });

  it("switching versions repoints current and keeps the old version dir", async () => {
    await pointCurrent({ appRoot, version: "0.1.0", platform: process.platform });
    await pointCurrent({ appRoot, version: "0.2.0", platform: process.platform });
    expect(readFileSync(path.join(appRoot, "current", "main.js"), "utf8")).toBe("// v2\n");
    expect(readFileSync(path.join(appRoot, "0.1.0", "main.js"), "utf8")).toBe("// v1\n");
  });

  it("a real directory named current → error, nothing deleted", async () => {
    write(path.join(appRoot, "current", "keep.txt"), "mine\n");
    await expect(pointCurrent({ appRoot, version: "0.2.0", platform: process.platform })).rejects.toThrow(/current/);
    expect(readFileSync(path.join(appRoot, "current", "keep.txt"), "utf8")).toBe("mine\n");
    expect(lstatSync(path.join(appRoot, "current")).isSymbolicLink()).toBe(false);
  });

  it("a missing version dir → error, current unchanged", async () => {
    await pointCurrent({ appRoot, version: "0.1.0", platform: process.platform });
    await expect(pointCurrent({ appRoot, version: "9.9.9", platform: process.platform })).rejects.toThrow(/9\.9\.9/);
    expect(readFileSync(path.join(appRoot, "current", "main.js"), "utf8")).toBe("// v1\n");
  });
});

describe("pointCurrent (injected fs, both platform branches)", () => {
  function fakeFs(existing: "none" | "link" | "dir") {
    const calls: unknown[][] = [];
    const notFound = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const fs = {
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      lstat: vi.fn(async () => {
        if (existing === "none") throw notFound();
        return { isSymbolicLink: () => existing === "link", isDirectory: () => existing === "dir" };
      }),
      unlink: vi.fn(async (...args: unknown[]) => void calls.push(["unlink", ...args])),
      symlink: vi.fn(async (...args: unknown[]) => void calls.push(["symlink", ...args])),
    };
    return { fs, calls };
  }

  it("darwin → a symlink to the version dir", async () => {
    const appRoot = "/Users/eric/Library/Application Support/snapsolve/app";
    const { fs, calls } = fakeFs("none");
    await pointCurrent({ appRoot, version: "0.2.0", platform: "darwin", fs });
    expect(calls).toEqual([["symlink", `${appRoot}/0.2.0`, `${appRoot}/current`, "dir"]]);
  });

  it("darwin with an existing link → the old link removed first", async () => {
    const appRoot = "/Users/eric/Library/Application Support/snapsolve/app";
    const { fs, calls } = fakeFs("link");
    await pointCurrent({ appRoot, version: "0.2.0", platform: "darwin", fs });
    expect(calls).toEqual([
      ["unlink", `${appRoot}/current`],
      ["symlink", `${appRoot}/0.2.0`, `${appRoot}/current`, "dir"],
    ]);
  });

  it("win32 → a junction", async () => {
    const appRoot = "C:\\Users\\eric\\AppData\\Local\\snapsolve\\app";
    const { fs, calls } = fakeFs("none");
    await pointCurrent({ appRoot, version: "0.2.0", platform: "win32", fs });
    expect(calls).toEqual([["symlink", `${appRoot}\\0.2.0`, `${appRoot}\\current`, "junction"]]);
  });

  it("a real directory → error, neither unlink nor symlink called", async () => {
    const { fs, calls } = fakeFs("dir");
    await expect(pointCurrent({ appRoot: "/a/app", version: "0.2.0", platform: "darwin", fs })).rejects.toThrow(/current/);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// packageBootstrap and the Start-menu shortcut

describe("packageBootstrap", () => {
  let versionDir: string;
  let programs: string;
  let shortcut: string;

  beforeEach(() => {
    versionDir = path.join(tmp, "data", "app", "0.2.0");
    write(path.join(versionDir, "package.json"), JSON.stringify({ version: "0.2.0", devDependencies: { electron: "44.7.2" } }));
    write(path.join(versionDir, "bootstrap", "boot.js"), "// boot\n");
    write(path.join(versionDir, "bootstrap", "package.json"), '{ "name": "snapsolve", "main": "boot.js" }\n');
    write(path.join(versionDir, "assets", "icon.ico"), Buffer.from([0, 0, 1, 0]));
    programs = path.join(tmp, "O'Brien Apps", "Programs", "snapsolve");
    shortcut = path.join(tmp, "Roaming", "Start Menu", "Programs", "snapsolve.lnk");
  });

  /** A packager that writes a fake app dir under `out` the way @electron/packager names it. */
  function fakePackager(exeContent = "exe-v2") {
    const seen: Array<Record<string, unknown>> = [];
    const packager = vi.fn(async (opts: Record<string, unknown>) => {
      seen.push(opts);
      const appDir = path.join(opts.out as string, "snapsolve-win32-x64");
      write(path.join(appDir, "snapsolve.exe"), exeContent);
      write(path.join(appDir, "resources", "app", "boot.js"), "// boot\n");
      return [appDir];
    });
    return { packager, seen, loadPackager: vi.fn(async () => packager) };
  }

  const okShell = () => fakeExec(() => ok());

  it("passes exactly the documented options, with electronVersion from app/package.json and the icon", async () => {
    const { seen, loadPackager } = fakePackager();
    await packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: okShell().exec, loadPackager });
    expect(loadPackager).toHaveBeenCalledWith(versionDir);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      dir: path.join(versionDir, "bootstrap"),
      name: "snapsolve",
      appBundleId: "com.snapsolve.app",
      electronVersion: "44.7.2",
      icon: path.join(versionDir, "assets", "icon.ico"),
      overwrite: true,
      out: expect.any(String),
    });
  });

  it("no icon in the payload → no icon option", async () => {
    await rm(path.join(versionDir, "assets"), { recursive: true });
    const { seen, loadPackager } = fakePackager();
    await packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: okShell().exec, loadPackager });
    expect(seen[0]).not.toHaveProperty("icon");
  });

  it("output replaces an existing Programs dir; the packager's out dir is gone afterwards", async () => {
    write(path.join(programs, "snapsolve.exe"), "exe-v1");
    write(path.join(programs, "old-only.txt"), "old");
    const { seen, loadPackager } = fakePackager("exe-v2");
    const r = await packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: okShell().exec, loadPackager });
    expect(r).toEqual({ exe: path.join(programs, "snapsolve.exe") });
    expect(files(programs)).toEqual(["resources/app/boot.js", "snapsolve.exe"]);
    expect(readFileSync(path.join(programs, "snapsolve.exe"), "utf8")).toBe("exe-v2");
    expect(existsSync(seen[0].out as string)).toBe(false);
    expect(readdirSync(path.dirname(programs))).toEqual(["snapsolve"]);
  });

  it("the previous launcher cannot be removed after the swap → warnings name the leftover dir; the new launcher is in place", async () => {
    write(path.join(programs, "snapsolve.exe"), "exe-v1");
    const { loadPackager } = fakePackager("exe-v2");
    const { rm: realRm } = await import("node:fs/promises");
    const removeFails = vi.fn(async (target: string, opts?: Parameters<typeof realRm>[1]) => {
      if (path.basename(target).startsWith(".snapsolve-old-")) throw spawnError("EBUSY");
      return realRm(target, opts);
    });
    const r = await packageBootstrap({
      versionDir,
      programs,
      shortcut,
      platform: "win32",
      exec: okShell().exec,
      loadPackager,
      rm: removeFails,
    });
    const leftovers = readdirSync(path.dirname(programs)).filter((n) => n.startsWith(".snapsolve-old-"));
    expect(leftovers).toHaveLength(1);
    const leftover = path.join(path.dirname(programs), leftovers[0]);
    expect(readFileSync(path.join(leftover, "snapsolve.exe"), "utf8")).toBe("exe-v1");
    expect(r).toEqual({ exe: path.join(programs, "snapsolve.exe"), warnings: [expect.stringContaining(leftover)] });
    expect(readFileSync(path.join(programs, "snapsolve.exe"), "utf8")).toBe("exe-v2");
    expect(removeFails).toHaveBeenCalledWith(leftover, expect.anything());
  });

  it("an injected rm that succeeds → no warnings key, no leftover dir", async () => {
    write(path.join(programs, "snapsolve.exe"), "exe-v1");
    const { loadPackager } = fakePackager("exe-v2");
    const { rm: realRm } = await import("node:fs/promises");
    const removeOk = vi.fn(realRm);
    const r = await packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: okShell().exec, loadPackager, rm: removeOk });
    expect(r).toEqual({ exe: path.join(programs, "snapsolve.exe") });
    expect(removeOk.mock.calls.some(([target]) => path.basename(String(target)).startsWith(".snapsolve-old-"))).toBe(true);
    expect(readdirSync(path.dirname(programs))).toEqual(["snapsolve"]);
  });

  it("first install (no previous launcher) → nothing to remove, no warnings", async () => {
    const { loadPackager } = fakePackager("exe-v2");
    const removeFails = vi.fn(async () => {
      throw spawnError("EBUSY");
    });
    const r = await packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: okShell().exec, loadPackager, rm: removeFails });
    expect(r).toEqual({ exe: path.join(programs, "snapsolve.exe") });
    expect(removeFails.mock.calls.some(([target]) => path.basename(String(target)).startsWith(".snapsolve-old-"))).toBe(false);
  });

  for (const electron of ["^44", "~44.7.2", "44", "latest", undefined]) {
    it(`electron ${JSON.stringify(electron)} in app/package.json → error, packager not run`, async () => {
      write(path.join(versionDir, "package.json"), JSON.stringify({ version: "0.2.0", devDependencies: { electron } }));
      const { packager, loadPackager } = fakePackager();
      await expect(
        packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: okShell().exec, loadPackager }),
      ).rejects.toThrow(/electron/i);
      expect(packager).not.toHaveBeenCalled();
    });
  }

  it("packager throws → error, the existing Programs dir untouched, no leftovers", async () => {
    write(path.join(programs, "snapsolve.exe"), "exe-v1");
    const packager = vi.fn(async (opts: Record<string, unknown>) => {
      write(path.join(opts.out as string, "partial.txt"), "x");
      throw new Error("download failed: ETIMEDOUT");
    });
    const shell = okShell();
    await expect(
      packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: shell.exec, loadPackager: async () => packager }),
    ).rejects.toThrow(/ETIMEDOUT/);
    expect(files(programs)).toEqual(["snapsolve.exe"]);
    expect(readFileSync(path.join(programs, "snapsolve.exe"), "utf8")).toBe("exe-v1");
    expect(readdirSync(path.dirname(programs))).toEqual(["snapsolve"]);
    expect(shell.calls).toEqual([]);
  });

  it("moving the new launcher into Programs fails → the previous launcher is put back, no shortcut written", async () => {
    write(path.join(programs, "snapsolve.exe"), "exe-v1");
    const { loadPackager } = fakePackager("exe-v2");
    const shell = okShell();
    const { rename: realRename } = await import("node:fs/promises");
    const rename = vi.fn(async (from: string, to: string) => {
      if (path.basename(from) === "snapsolve-win32-x64") throw spawnError("EBUSY");
      return realRename(from, to);
    });
    await expect(
      packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: shell.exec, loadPackager, rename }),
    ).rejects.toThrow(/EBUSY/);
    expect(readFileSync(path.join(programs, "snapsolve.exe"), "utf8")).toBe("exe-v1");
    expect(readdirSync(path.dirname(programs))).toEqual(["snapsolve"]);
    expect(shell.calls).toEqual([]);
  });

  // M3 (task 031) packages on darwin (see "packageBootstrap (darwin)"); other platforms are still refused.
  it("linux → not supported, nothing packaged", async () => {
    const { packager, loadPackager } = fakePackager();
    await expect(
      packageBootstrap({ versionDir, programs, shortcut, platform: "linux", exec: okShell().exec, loadPackager }),
    ).rejects.toThrow(/linux/);
    expect(packager).not.toHaveBeenCalled();
  });

  it("creates the shortcut with an encoded PowerShell script that targets the exe", async () => {
    const { loadPackager } = fakePackager();
    const shell = okShell();
    await packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec: shell.exec, loadPackager });
    expect(shell.calls).toHaveLength(1);
    const { command, args } = shell.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toBe(shortcutScript({ shortcut, target: path.join(programs, "snapsolve.exe"), workingDirectory: programs }));
    expect(existsSync(path.dirname(shortcut))).toBe(true);
  });

  it("the shortcut script failing → error quoting PowerShell's output", async () => {
    const { loadPackager } = fakePackager();
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: "Exception calling Save\n" }));
    await expect(packageBootstrap({ versionDir, programs, shortcut, platform: "win32", exec, loadPackager })).rejects.toThrow(
      /shortcut[\s\S]*Exception calling Save/,
    );
  });
});

describe("packageBootstrap (darwin)", () => {
  let versionDir: string;
  let bundle: string;

  beforeEach(() => {
    versionDir = path.join(tmp, "data", "app", "0.2.0");
    write(path.join(versionDir, "package.json"), JSON.stringify({ version: "0.2.0", devDependencies: { electron: "44.7.2" } }));
    write(path.join(versionDir, "bootstrap", "boot.js"), "// boot\n");
    write(path.join(versionDir, "assets", "icon.icns"), "icns");
    write(path.join(versionDir, "assets", "icon.ico"), "ico");
    bundle = path.join(tmp, "home", "Applications", "snapsolve.app");
  });

  /** Writes `<out>/snapsolve-darwin-arm64/snapsolve.app` the way @electron/packager lays out a macOS build. */
  function fakeMacPackager(binary = "mach-o v2") {
    const seen: Array<Record<string, unknown>> = [];
    const packager = vi.fn(async (opts: Record<string, unknown>) => {
      seen.push(opts);
      const dir = path.join(opts.out as string, "snapsolve-darwin-arm64");
      write(path.join(dir, "snapsolve.app", "Contents", "MacOS", "snapsolve"), binary);
      write(path.join(dir, "snapsolve.app", "Contents", "Info.plist"), "<plist/>");
      write(path.join(dir, "LICENSE"), "MIT");
      return [dir];
    });
    return { packager, seen, loadPackager: vi.fn(async () => packager) };
  }

  it("packages an LSUIElement bundle into ~/Applications (created), then ad-hoc signs it exactly once", async () => {
    const { seen, loadPackager } = fakeMacPackager();
    const shell = fakeExec(() => ok());
    const r = await packageBootstrap({ versionDir, programs: bundle, shortcut: null, platform: "darwin", exec: shell.exec, loadPackager });
    expect(seen[0]).toEqual({
      dir: path.join(versionDir, "bootstrap"),
      name: "snapsolve",
      appBundleId: "com.snapsolve.app",
      electronVersion: "44.7.2",
      icon: path.join(versionDir, "assets", "icon.icns"),
      overwrite: true,
      out: expect.any(String),
      platform: "darwin",
      // 063: the usage strings macOS shows when voice first asks for the microphone and speech recognition.
      extendInfo: {
        LSUIElement: true,
        NSMicrophoneUsageDescription: "snapsolve listens while you dictate a question with the voice hotkey.",
        NSSpeechRecognitionUsageDescription: "snapsolve turns your dictated question into text on this Mac.",
      },
    });
    expect(r).toEqual({ exe: path.join(bundle, "Contents", "MacOS", "snapsolve") });
    expect(files(bundle)).toEqual(["Contents/Info.plist", "Contents/MacOS/snapsolve"]);
    expect(readdirSync(path.dirname(bundle))).toEqual(["snapsolve.app"]);
    expect(shell.calls.map((c) => [c.command, c.args])).toEqual([["codesign", ["--force", "--deep", "--sign", "-", bundle]]]);
  });

  it("replaces an existing bundle", async () => {
    write(path.join(bundle, "Contents", "MacOS", "snapsolve"), "mach-o v1");
    write(path.join(bundle, "Contents", "old.txt"), "old");
    const { loadPackager } = fakeMacPackager("mach-o v2");
    const shell = fakeExec(() => ok());
    await packageBootstrap({ versionDir, programs: bundle, shortcut: null, platform: "darwin", exec: shell.exec, loadPackager });
    expect(readFileSync(path.join(bundle, "Contents", "MacOS", "snapsolve"), "utf8")).toBe("mach-o v2");
    expect(existsSync(path.join(bundle, "Contents", "old.txt"))).toBe(false);
  });

  it("the previous bundle cannot be removed after the swap → warnings name it; the new bundle is in place and signed once", async () => {
    write(path.join(bundle, "Contents", "MacOS", "snapsolve"), "mach-o v1");
    const { loadPackager } = fakeMacPackager("mach-o v2");
    const shell = fakeExec(() => ok());
    const { rm: realRm } = await import("node:fs/promises");
    const removeFails = vi.fn(async (target: string, opts?: Parameters<typeof realRm>[1]) => {
      if (path.basename(target).startsWith(".snapsolve.app-old-")) throw spawnError("EACCES");
      return realRm(target, opts);
    });
    const r = await packageBootstrap({
      versionDir,
      programs: bundle,
      shortcut: null,
      platform: "darwin",
      exec: shell.exec,
      loadPackager,
      rm: removeFails,
    });
    const leftovers = readdirSync(path.dirname(bundle)).filter((n) => n.startsWith(".snapsolve.app-old-"));
    expect(leftovers).toHaveLength(1);
    const leftover = path.join(path.dirname(bundle), leftovers[0]);
    expect(r).toEqual({ exe: path.join(bundle, "Contents", "MacOS", "snapsolve"), warnings: [expect.stringContaining(leftover)] });
    expect(readFileSync(path.join(bundle, "Contents", "MacOS", "snapsolve"), "utf8")).toBe("mach-o v2");
    expect(shell.calls.map((c) => [c.command, c.args])).toEqual([["codesign", ["--force", "--deep", "--sign", "-", bundle]]]);
  });

  it("no .icns in the payload → no icon option (the Windows .ico is never used)", async () => {
    await rm(path.join(versionDir, "assets", "icon.icns"));
    const { seen, loadPackager } = fakeMacPackager();
    const shell = fakeExec(() => ok());
    await packageBootstrap({ versionDir, programs: bundle, shortcut: null, platform: "darwin", exec: shell.exec, loadPackager });
    expect(seen[0]).not.toHaveProperty("icon");
  });

  it("codesign fails → error quoting it", async () => {
    const { loadPackager } = fakeMacPackager();
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: "snapsolve.app: resource fork not allowed\n" }));
    await expect(
      packageBootstrap({ versionDir, programs: bundle, shortcut: null, platform: "darwin", exec, loadPackager }),
    ).rejects.toThrow(/codesign[\s\S]*resource fork not allowed/);
  });

  it("packager output without snapsolve.app → error, nothing signed", async () => {
    const packager = vi.fn(async (opts: Record<string, unknown>) => {
      const dir = path.join(opts.out as string, "snapsolve-darwin-arm64");
      write(path.join(dir, "LICENSE"), "MIT");
      return [dir];
    });
    const shell = fakeExec(() => ok());
    await expect(
      packageBootstrap({
        versionDir,
        programs: bundle,
        shortcut: null,
        platform: "darwin",
        exec: shell.exec,
        loadPackager: async () => packager,
      }),
    ).rejects.toThrow(/snapsolve\.app/);
    expect(shell.calls).toEqual([]);
  });
});

describe("loadPackager", () => {
  it("imports the real @electron/packager from the version dir's node_modules (here: the repo's)", async () => {
    const packager = await loadPackager(repoRoot);
    expect(typeof packager).toBe("function");
    expect(packager.name).toBe("packager");
  });

  it("a version dir without it installed → error", async () => {
    write(path.join(tmp, "v", "package.json"), "{}");
    await expect(loadPackager(path.join(tmp, "v"))).rejects.toThrow(/@electron\/packager/);
  });
});

describe("shortcutScript", () => {
  it("single-quotes every path and doubles embedded apostrophes", () => {
    const script = shortcutScript({
      shortcut: "C:\\Users\\o'neil\\Start Menu\\snapsolve.lnk",
      target: "C:\\Users\\o'neil\\Programs\\snap solve\\snapsolve.exe",
      workingDirectory: "C:\\Users\\o'neil\\Programs\\snap solve",
    });
    expect(script).toContain("'C:\\Users\\o''neil\\Start Menu\\snapsolve.lnk'");
    expect(script).toContain("'C:\\Users\\o''neil\\Programs\\snap solve\\snapsolve.exe'");
    expect(script).toContain("'C:\\Users\\o''neil\\Programs\\snap solve'");
    expect(script).not.toContain('"');
    expect(script).toMatch(/WScript\.Shell/);
    expect(script).toMatch(/\.Save\(\)/);
  });

  it.runIf(process.platform === "win32")(
    "really creates a shortcut whose target has spaces and an apostrophe (PowerShell + WScript.Shell)",
    async () => {
      const dir = path.join(tmp, "Bob's Programs", "snap solve");
      const target = path.join(dir, "snapsolve.exe");
      write(target, "not really an exe");
      const lnk = path.join(tmp, "Start Menu's Programs", "snapsolve.lnk");
      mkdirSync(path.dirname(lnk), { recursive: true });
      const script = shortcutScript({ shortcut: lnk, target, workingDirectory: dir });
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const made = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
      expect(made.code, made.stderr).toBe(0);
      expect(existsSync(lnk)).toBe(true);

      const quoted = lnk.replace(/'/g, "''");
      const readBack = `$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${quoted}'); Write-Output $l.TargetPath; Write-Output $l.WorkingDirectory`;
      const read = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(readBack, "utf16le").toString("base64"),
      ]);
      expect(read.stdout.trim().split(/\r?\n/)).toEqual([target, dir]);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// compareVersions (task 044: SemVer precedence, shared by preflight, doctor and update)

describe("compareVersions", () => {
  for (const [a, b, expected] of [
    ["0.2.0-beta.1", "0.2.0", -1],
    ["0.2.0", "0.2.0-beta.1", 1],
    ["0.2.0-beta.2", "0.2.0-beta.1", 1],
    ["0.2.0-beta.10", "0.2.0-beta.9", 1],
    ["0.2.0-beta", "0.2.0-beta.1", -1],
    ["0.2.0-1", "0.2.0-alpha", -1],
    ["0.2.0-alpha", "0.2.0-beta", -1],
    ["1.0.0+build.5", "1.0.0", 0],
    ["1.0.0-rc.1+b", "1.0.0-rc.1", 0],
    ["v22.12.0", "22.12.0", 0],
    ["v22.11.9", "22.12.0", -1],
    ["0.10.0", "0.9.0", 1],
  ] as const) {
    it(`${a} vs ${b} → ${expected}`, () => {
      expect(compareVersions(a, b)).toBe(expected);
    });
  }

  for (const [a, b] of [
    ["garbage", "1.0.0"],
    ["1.0.0", "garbage"],
    ["1.0", "1.0.0"],
    ["1.0.0-", "1.0.0"],
    [null, "1.0.0"],
    ["1.0.0", undefined],
  ] as const) {
    it(`unparsable ${String(a)} vs ${String(b)} → null`, () => {
      expect(compareVersions(a as unknown as string, b as unknown as string)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Shared fs helpers (task 045: commands.mjs imports these instead of keeping copies)

describe("exists / linkExists", () => {
  it("a dangling junction: linkExists true, exists false", async () => {
    const target = path.join(tmp, "target");
    const link = path.join(tmp, "link");
    mkdirSync(target);
    symlinkSync(target, link, "junction");
    await rm(target, { recursive: true });
    expect(await linkExists(link)).toBe(true);
    expect(await exists(link)).toBe(false);
  });

  it("a live junction and a plain file: both true; a missing path: both false", async () => {
    const target = path.join(tmp, "target");
    mkdirSync(target);
    symlinkSync(target, path.join(tmp, "link"), "junction");
    write(path.join(tmp, "file.txt"), "x");
    for (const p of [path.join(tmp, "link"), path.join(tmp, "file.txt")]) {
      expect(await exists(p)).toBe(true);
      expect(await linkExists(p)).toBe(true);
    }
    expect(await exists(path.join(tmp, "nope"))).toBe(false);
    expect(await linkExists(path.join(tmp, "nope"))).toBe(false);
  });
});

describe("readJson", () => {
  it("parses JSON (a UTF-8 BOM allowed); missing or invalid → undefined", async () => {
    write(path.join(tmp, "a.json"), '﻿{"version":"0.2.0"}');
    write(path.join(tmp, "bad.json"), "{ nope");
    expect(await readJson(path.join(tmp, "a.json"))).toEqual({ version: "0.2.0" });
    expect(await readJson(path.join(tmp, "bad.json"))).toBeUndefined();
    expect(await readJson(path.join(tmp, "missing.json"))).toBeUndefined();
  });
});

describe("renameRetrying", () => {
  it("renames a file", async () => {
    write(path.join(tmp, "from"), "x");
    await renameRetrying(path.join(tmp, "from"), path.join(tmp, "to"));
    expect(readFileSync(path.join(tmp, "to"), "utf8")).toBe("x");
    expect(existsSync(path.join(tmp, "from"))).toBe(false);
  });

  it("a missing source (ENOENT, not transient) rejects without retrying", async () => {
    await expect(renameRetrying(path.join(tmp, "nope"), path.join(tmp, "to"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// writeClaudePath

describe("writeClaudePath", () => {
  let configFile: string;
  let claudeReal: string;
  let claudeViaLink: string;

  beforeEach(() => {
    configFile = path.join(tmp, "data", "config.json");
    write(path.join(tmp, "real-bin", "claude.exe"), "binary");
    claudeReal = realpathSync.native(path.join(tmp, "real-bin", "claude.exe"));
    symlinkSync(path.join(tmp, "real-bin"), path.join(tmp, "linked-bin"), "junction");
    claudeViaLink = path.join(tmp, "linked-bin", "claude.exe");
  });

  it("missing config → the app's full defaults with claudePath = realpath, and loadConfig reads it without warnings", async () => {
    const r = await writeClaudePath({ configFile, claudePath: claudeViaLink });
    const written = JSON.parse(readFileSync(configFile, "utf8"));
    expect(Object.keys(written)).toEqual(Object.keys(DEFAULTS));
    expect(written).toEqual({ ...DEFAULTS, claudePath: claudeReal });
    expect(written.hotkeys.capture).toBe("Control+Alt+C");
    expect(written.hotkeys.voice).toBe("Control+Alt+V");
    expect(written.theme).toBe("dark");
    expect(r).toEqual({ claudePath: claudeReal, warning: null });

    const loaded = await loadConfig(configFile);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.created).toBe(false);
    expect(loaded.config.claudePath).toBe(claudeReal);
  });

  it("existing config with user values → only claudePath changes, keys keep their order, no temp files left", async () => {
    const before = {
      model: "sonnet",
      hotkeys: { capture: "Control+Alt+W", append: "Control+Alt+Shift+W" },
      claudePath: "C:\\old\\claude.exe",
      panelWidth: 600,
      someFutureKey: { nested: [1, 2] },
    };
    write(configFile, `${JSON.stringify(before, null, 2)}\n`);
    await writeClaudePath({ configFile, claudePath: claudeViaLink });
    const after = JSON.parse(readFileSync(configFile, "utf8"));
    expect(after).toEqual({ ...before, claudePath: claudeReal });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(readdirSync(path.dirname(configFile))).toEqual(["config.json"]);
  });

  it("a UTF-8 BOM before valid JSON is accepted (the app accepts it too)", async () => {
    write(configFile, `\uFEFF${JSON.stringify({ model: "sonnet" })}`);
    await writeClaudePath({ configFile, claudePath: claudeReal });
    expect(JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""))).toEqual({ model: "sonnet", claudePath: claudeReal });
  });

  for (const [label, content] of [
    ["invalid JSON", "{ model: sonnet,"],
    ["a JSON array", "[1, 2]\n"],
    ["JSON null", "null"],
  ] as const) {
    it(`${label} → file byte-identical, a warning returned`, async () => {
      write(configFile, content);
      const r = await writeClaudePath({ configFile, claudePath: claudeReal });
      expect(readFileSync(configFile, "utf8")).toBe(content);
      expect(r.warning).toMatch(/config\.json/);
      expect(r.warning).toContain(claudeReal);
      expect(readdirSync(path.dirname(configFile))).toEqual(["config.json"]);
    });
  }

  it("claude path that does not exist → error, no config written", async () => {
    await expect(writeClaudePath({ configFile, claudePath: path.join(tmp, "nope", "claude.exe") })).rejects.toThrow(/claude/);
    expect(existsSync(configFile)).toBe(false);
  });

  it("win32 given explicitly → still stores the realpath", async () => {
    const r = await writeClaudePath({ configFile, claudePath: claudeViaLink, platform: "win32" });
    expect(JSON.parse(readFileSync(configFile, "utf8")).claudePath).toBe(claudeReal);
    expect(r).toEqual({ claudePath: claudeReal, warning: null });
  });

  // The native installer's ~/.local/bin/claude is a symlink into a version dir that auto-updates prune (task 043).
  describe("darwin", () => {
    const link = "/Users/e/.local/bin/claude";
    const versioned = "/Users/e/.local/share/claude/versions/2.1.299";

    it("stores the symlink as found (not its versioned target), after realpath confirms it resolves", async () => {
      const realpath = vi.fn(async () => versioned);
      const r = await writeClaudePath({ configFile, claudePath: link, platform: "darwin", realpath });
      expect(realpath).toHaveBeenCalledWith(link);
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ ...DEFAULTS, claudePath: link });
      expect(r).toEqual({ claudePath: link, warning: null });
    });

    it("a dangling symlink (realpath fails) → the claude-not-found error, config untouched", async () => {
      write(configFile, `${JSON.stringify({ model: "sonnet" })}\n`);
      const realpath = vi.fn(async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      });
      await expect(writeClaudePath({ configFile, claudePath: link, platform: "darwin", realpath })).rejects.toThrow(
        `claude not found at ${link}`,
      );
      expect(readFileSync(configFile, "utf8")).toBe(`${JSON.stringify({ model: "sonnet" })}\n`);
    });

    it("an existing config keeps its other keys", async () => {
      const before = { model: "sonnet", claudePath: "/old/claude", someFutureKey: 1 };
      write(configFile, JSON.stringify(before));
      await writeClaudePath({ configFile, claudePath: link, platform: "darwin", realpath: async () => versioned });
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ ...before, claudePath: link });
    });

    it("a non-object config.json → the warning names the symlink path, not the versioned target", async () => {
      write(configFile, "[1, 2]\n");
      const r = await writeClaudePath({ configFile, claudePath: link, platform: "darwin", realpath: async () => versioned });
      expect(readFileSync(configFile, "utf8")).toBe("[1, 2]\n");
      expect(r.claudePath).toBe(link);
      expect(r.warning).toContain(link);
      expect(r.warning).not.toContain(versioned);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// launch, quitAndWait, processRunning, asrCheck, run

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: 4242 });
  return child;
}

describe("launch", () => {
  it("starts the exe detached, without CLAUDECODE / CLAUDE_CODE_* in its env, and lets it go", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const env = {
      PATH: "C:\\Windows",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "51234",
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CONFIG_DIR: "C:\\cfg",
    };
    await launch({ exe: "C:\\P\\snapsolve.exe", env, spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe("C:\\P\\snapsolve.exe");
    expect(args).toEqual([]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(options.env).toEqual({ PATH: "C:\\Windows", ANTHROPIC_MODEL: "opus", CLAUDE_CONFIG_DIR: "C:\\cfg" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("a spawn error (ASR EPERM, missing exe) → rejects with the code and the exe", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", spawnError("EPERM")));
      return child;
    });
    await expect(launch({ exe: "C:\\P\\snapsolve.exe", env: {}, spawn })).rejects.toThrow(/EPERM[\s\S]*snapsolve\.exe|snapsolve\.exe[\s\S]*EPERM/);
  });

  it("darwin → `open -a <bundle>` (DESIGN §4.2 step 6), detached, without CLAUDECODE / CLAUDE_CODE_*", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const env = { PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HOME: "/Users/eric" };
    await launch({ exe: "/Users/eric/Applications/snapsolve.app/Contents/MacOS/snapsolve", env, spawn, platform: "darwin" });
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe("open");
    expect(args).toEqual(["-a", "/Users/eric/Applications/snapsolve.app"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(options.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/eric" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("darwin with an exe outside an .app bundle → rejects, nothing spawned", async () => {
    const spawn = vi.fn();
    await expect(launch({ exe: "/usr/local/bin/snapsolve", env: {}, spawn, platform: "darwin" })).rejects.toThrow(/\.app/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

/** A fake clock that `sleep` advances, so a quitAndWait that keeps polling hits its deadline instead of spinning. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => void (t += ms)) };
}

describe("quitAndWait", () => {
  it("not running → returns at once without starting the exe", async () => {
    const { exec, calls } = fakeExec(() => ok());
    const c = clock();
    await quitAndWait({ exe: "C:\\P\\snapsolve.exe", exec, isRunning: async () => false, ...c });
    expect(calls).toEqual([]);
  });

  it("running → sends --quit, polls, returns once the process is gone", async () => {
    const { exec, calls } = fakeExec(() => ok());
    const c = clock();
    const states = [true, true, true, false];
    const isRunning = vi.fn(async () => states.shift() ?? false);
    await quitAndWait({ exe: "C:\\P\\snapsolve.exe", exec, isRunning, ...c });
    expect(calls.map((x) => [x.command, x.args])).toEqual([["C:\\P\\snapsolve.exe", ["--quit"]]]);
    expect(isRunning).toHaveBeenCalledTimes(4);
    expect(c.now()).toBeLessThan(5000);
  });

  it("still running after 5 s (fake clock) → error naming the exe", async () => {
    const { exec } = fakeExec(() => ok());
    const c = clock();
    const isRunning = vi.fn(async () => true);
    await expect(quitAndWait({ exe: "C:\\P\\snapsolve.exe", exec, isRunning, ...c })).rejects.toThrow(/C:\\P\\snapsolve\.exe/);
    expect(c.now()).toBeGreaterThanOrEqual(5000);
    expect(c.now()).toBeLessThan(6000);
  });
});

describe("quitAndWait (win32, default isRunning)", () => {
  const exe = "C:\\P\\snapsolve.exe";
  const listed = '"snapsolve.exe","4242","Console","1","98,000 K"\r\n';
  const none = "INFO: No tasks are running which match the specified criteria.\r\n";

  it("checks tasklist for the exe's basename (not the full path), sends --quit, waits until tasklist no longer lists it", async () => {
    const outputs = [listed, listed, none];
    const { exec, calls } = fakeExec(({ command }) => (command === "tasklist" ? ok(outputs.shift() ?? none) : ok()));
    let t = 0;
    await quitAndWait({ exe, exec, now: () => t, sleep: async (ms: number) => void (t += ms) });
    const tasklist = ["/FI", "IMAGENAME eq snapsolve.exe", "/FO", "CSV", "/NH"];
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      ["tasklist", tasklist],
      [exe, ["--quit"]],
      ["tasklist", tasklist],
      ["tasklist", tasklist],
    ]);
  });

  it("tasklist does not list it → no --quit, nothing started", async () => {
    const { exec, calls } = fakeExec(() => ok(none));
    await quitAndWait({ exe, exec, ...clock() });
    expect(calls.map((c) => c.command)).toEqual(["tasklist"]);
  });

  it("tasklist lists another image that merely contains the name → not running, no --quit", async () => {
    const { exec, calls } = fakeExec(() => ok('"snapsolve.exe.bak.exe","77","Console","1","1,000 K"\r\n'));
    await quitAndWait({ exe, exec, ...clock() });
    expect(calls.map((c) => c.command)).toEqual(["tasklist"]);
  });

  it("tasklist itself fails → the error propagates, no --quit", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 1, stdout: "", stderr: "ERROR: Invalid argument" }));
    await expect(quitAndWait({ exe, exec, ...clock() })).rejects.toThrow(/tasklist failed/);
    expect(calls.map((c) => c.command)).toEqual(["tasklist"]);
  });
});

describe("quitAndWait (darwin, default isRunning)", () => {
  it("checks with pgrep for the bundle binary's name, sends --quit to the binary, waits until pgrep finds nothing", async () => {
    const exe = "/Users/eric/Applications/snapsolve.app/Contents/MacOS/snapsolve";
    const pgrep = [0, 0, 1];
    const { exec, calls } = fakeExec(({ command }) => (command === "pgrep" ? { code: pgrep.shift() ?? 1, stdout: "", stderr: "" } : ok()));
    let t = 0;
    await quitAndWait({ exe, exec, platform: "darwin", now: () => t, sleep: async (ms: number) => void (t += ms) });
    expect(calls.map((c) => [c.command, c.args])).toEqual([
      ["pgrep", ["-x", "snapsolve"]],
      [exe, ["--quit"]],
      ["pgrep", ["-x", "snapsolve"]],
      ["pgrep", ["-x", "snapsolve"]],
    ]);
  });
});

describe("processRunning (pgrep, darwin)", () => {
  it("exit 0 → running; exit 1 → not running; anything else → error", async () => {
    const codes = [0, 1, 2];
    const { exec, calls } = fakeExec(() => ({ code: codes.shift()!, stdout: "", stderr: "pgrep: bad option" }));
    expect(await processRunning({ image: "snapsolve", exec, platform: "darwin" })).toBe(true);
    expect(await processRunning({ image: "snapsolve", exec, platform: "darwin" })).toBe(false);
    await expect(processRunning({ image: "snapsolve", exec, platform: "darwin" })).rejects.toThrow(/pgrep/);
    expect(calls[0].args).toEqual(["-x", "snapsolve"]);
  });
});

describe("processRunning (tasklist)", () => {
  it("matches the image name in tasklist's CSV output", async () => {
    const { exec, calls } = fakeExec(() => ok('"snapsolve.exe","4242","Console","1","98,000 K"\r\n'));
    expect(await processRunning({ image: "snapsolve.exe", exec })).toBe(true);
    expect(calls[0].command).toBe("tasklist");
    expect(calls[0].args).toEqual(["/FI", "IMAGENAME eq snapsolve.exe", "/FO", "CSV", "/NH"]);
  });

  it("tasklist's no-match message → false", async () => {
    const { exec } = fakeExec(() => ok("INFO: No tasks are running which match the specified criteria.\r\n"));
    expect(await processRunning({ image: "snapsolve.exe", exec })).toBe(false);
  });
});

describe("asrCheck", () => {
  const exe = "C:\\P\\snapsolve.exe";

  it("spawn error EPERM → blocked", async () => {
    const { exec } = fakeExec(() => {
      throw spawnError("EPERM");
    });
    expect(await asrCheck({ exe, exec })).toMatchObject({ status: "blocked" });
  });

  it("exit 0 with `snapsolve smoke ok` → ok; runs --smoke with a timeout", async () => {
    const { exec, calls } = fakeExec(() => ok("snapsolve smoke ok 0.2.0\n"));
    expect(await asrCheck({ exe, exec })).toMatchObject({ status: "ok" });
    expect(calls[0].command).toBe(exe);
    expect(calls[0].args).toEqual(["--smoke"]);
    expect(calls[0].options.timeoutMs).toBeGreaterThan(0);
  });

  it("exit 0 without the smoke line → failed", async () => {
    const { exec } = fakeExec(() => ok("something else\n"));
    expect(await asrCheck({ exe, exec })).toMatchObject({ status: "failed" });
  });

  it("other exit → failed with the output", async () => {
    const { exec } = fakeExec(() => ({ code: 1, stdout: "", stderr: "Cannot find module current/main.js\n" }));
    const r = await asrCheck({ exe, exec });
    expect(r.status).toBe("failed");
    expect(r.output).toContain("Cannot find module current/main.js");
  });

  it("timed out → failed", async () => {
    const { exec } = fakeExec(() => ({ code: null, stdout: "", stderr: "", timedOut: true }));
    expect(await asrCheck({ exe, exec })).toMatchObject({ status: "failed" });
  });

  it("exe missing (ENOENT) → failed, not blocked", async () => {
    const { exec } = fakeExec(() => {
      throw spawnError("ENOENT");
    });
    const r = await asrCheck({ exe, exec });
    expect(r.status).toBe("failed");
    expect(r.output).toContain("ENOENT");
  });
});

describe("run (the default exec)", () => {
  it("collects stdout, stderr and the exit code", async () => {
    const r = await run(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
    expect(r).toMatchObject({ code: 3, stdout: "out", stderr: "err", timedOut: false });
  });

  it("passes cwd and env", async () => {
    const r = await run(process.execPath, ["-e", "process.stdout.write(process.cwd() + '|' + process.env.STEPS_TEST)"], {
      cwd: tmp,
      env: { ...process.env, STEPS_TEST: "yes" },
    });
    const [cwd, value] = r.stdout.split("|");
    expect([tmp, realpathSync(tmp), realpathSync.native(tmp)]).toContain(cwd);
    expect(value).toBe("yes");
  });

  it("a spawn error rejects with its code", async () => {
    await expect(run(path.join(tmp, "missing.exe"), [])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the child after timeoutMs and reports timedOut", async () => {
    const started = Date.now();
    const r = await run(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
