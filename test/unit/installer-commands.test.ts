import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor, install, parseArgs, start, uninstall, update } from "../../plugin/skills/snapsolve/scripts/commands.mjs";

// fs.rename passes through unless a test overrides it (writeState's transient-rename retry, task 045).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = vi.fn(actual.rename);
  return { ...actual, rename, default: { ...actual, rename } };
});
import { repoRoot } from "../paths";

const CLI = path.join(repoRoot, "plugin", "skills", "snapsolve", "scripts", "snapsolve.mjs");
const CLAUDE = "C:\\Users\\eric\\.local\\bin\\claude.exe";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "snapsolve-commands-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

interface Options {
  pluginVersion?: string;
  electron?: string;
  preflight?: Record<string, unknown>;
  quitError?: Error;
  stageError?: Error;
  launchError?: Error;
  asr?: { status: string; output: string };
  platform?: "win32" | "darwin";
}

/**
 * Host-path install locations in a temp dir (laid out like installPaths for the platform: Programs + shortcut on
 * Windows, ~/Applications/snapsolve.app and no shortcut on macOS), a plugin `app/` payload, and fake steps that
 * record their order and touch the disk the way the real ones would (version dirs, the exe, config.json).
 */
function setup(options: Options = {}) {
  const platform = options.platform ?? "win32";
  const local = path.join(tmp, "Local");
  const data = path.join(local, "snapsolve");
  const programs = platform === "darwin" ? path.join(tmp, "home", "Applications", "snapsolve.app") : path.join(local, "Programs", "snapsolve");
  const paths = {
    data,
    appRoot: path.join(data, "app"),
    current: path.join(data, "app", "current"),
    config: path.join(data, "config.json"),
    programs,
    exe: platform === "darwin" ? path.join(programs, "Contents", "MacOS", "snapsolve") : path.join(programs, "snapsolve.exe"),
    shortcut: platform === "darwin" ? null : path.join(tmp, "Roaming", "Start Menu", "Programs", "snapsolve.lnk"),
  };
  const pluginApp = path.join(tmp, "plugin", "app");
  const electron = options.electron ?? "44.7.2";
  write(
    path.join(pluginApp, "package.json"),
    JSON.stringify({ version: options.pluginVersion ?? "0.2.0", devDependencies: { electron } }),
  );

  const calls: string[] = [];
  const pre = {
    ok: true,
    problems: [],
    warnings: [],
    claudePath: CLAUDE,
    claudeVersion: "2.1.300 (Claude Code)",
    auth: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" },
    ...options.preflight,
  };
  const steps = {
    preflight: vi.fn(async () => {
      calls.push("preflight");
      return pre;
    }),
    quitAndWait: vi.fn(async () => {
      calls.push("quit");
      if (options.quitError) throw options.quitError;
    }),
    stageVersion: vi.fn(async ({ source, appRoot }: { source: string; appRoot: string }) => {
      calls.push("stage");
      if (options.stageError) throw options.stageError;
      const { version } = readJson(path.join(source, "package.json"));
      const dir = path.join(appRoot, version);
      write(path.join(dir, "package.json"), readFileSync(path.join(source, "package.json"), "utf8"));
      return { version, dir };
    }),
    pointCurrent: vi.fn(async () => {
      calls.push("current");
    }),
    packageBootstrap: vi.fn(async () => {
      calls.push("package");
      write(paths.exe, `exe for electron ${electron}`);
      return { exe: paths.exe };
    }),
    writeClaudePath: vi.fn(async ({ configFile, claudePath }: { configFile: string; claudePath: string }) => {
      calls.push("claudePath");
      const existing = existsSync(configFile) ? readJson(configFile) : { hotkeys: { capture: "Control+Alt+C" } };
      write(configFile, JSON.stringify({ ...existing, claudePath }));
      return { claudePath, warning: null };
    }),
    launch: vi.fn(async () => {
      calls.push("launch");
      if (options.launchError) throw options.launchError;
    }),
    asrCheck: vi.fn(async () => {
      calls.push("asr");
      return options.asr ?? { status: "ok", output: "snapsolve smoke ok 0.2.0" };
    }),
  };
  const ctx = {
    platform,
    env: {},
    home: tmp,
    nodeVersion: "v22.12.0",
    pluginApp,
    paths: () => paths,
    steps,
  };
  return { ctx, steps, calls, paths, pluginApp };
}

/** An existing install of `version` (install.json, its version dir, the exe and a config with claudePath). */
function installed(paths: ReturnType<typeof setup>["paths"], version: string, electron = "44.7.2", claudePath: string | null = null) {
  write(path.join(paths.appRoot, version, "package.json"), JSON.stringify({ version, devDependencies: { electron } }));
  write(path.join(paths.appRoot, "install.json"), JSON.stringify({ version, electronVersion: electron, exe: paths.exe }));
  write(paths.exe, "exe");
  write(paths.config, JSON.stringify({ claudePath }));
}

const kinds = (lines: string[]) => lines.map((l) => l.split(":")[0]);
const spawnError = (code: string) => Object.assign(new Error(`spawn ${code}`), { code });

// ---------------------------------------------------------------------------------------------------------------

describe("install", () => {
  it("first install: preflight → stage → current → package → claudePath → launch, then install.json", async () => {
    const { ctx, calls, paths, steps, pluginApp } = setup();
    const r = await install(ctx);
    expect(r.code).toBe(0);
    expect(calls).toEqual(["preflight", "stage", "current", "package", "claudePath", "launch"]);
    expect(readJson(path.join(paths.appRoot, "install.json"))).toEqual({ version: "0.2.0", electronVersion: "44.7.2", exe: paths.exe });
    expect(steps.stageVersion).toHaveBeenCalledWith(expect.objectContaining({ source: pluginApp, appRoot: paths.appRoot, platform: "win32" }));
    expect(steps.pointCurrent).toHaveBeenCalledWith(expect.objectContaining({ appRoot: paths.appRoot, version: "0.2.0" }));
    expect(steps.packageBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ versionDir: path.join(paths.appRoot, "0.2.0"), programs: paths.programs, shortcut: paths.shortcut }),
    );
    expect(steps.writeClaudePath).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: paths.config, claudePath: CLAUDE, platform: "win32" }),
    );
    expect(steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: paths.exe }));
    expect(kinds(r.lines).every((k) => k === "ok")).toBe(true);
  });

  it("prints the active hotkey and the AltGr note", async () => {
    const { ctx } = setup();
    const r = await install(ctx);
    const text = r.lines.join("\n");
    expect(text).toContain("Ctrl+Alt+C");
    expect(text).toMatch(/AltGr/);
  });

  it("a user's existing capture value is kept: the old Control+Alt+Q stays in config.json and is the one shown", async () => {
    const { ctx, paths } = setup();
    write(paths.config, JSON.stringify({ hotkeys: { capture: "Control+Alt+Q" } }));
    const r = await install(ctx);
    expect(readJson(paths.config).hotkeys).toEqual({ capture: "Control+Alt+Q" });
    const text = r.lines.join("\n");
    expect(text).toContain("Ctrl+Alt+Q");
    expect(text).not.toContain("Ctrl+Alt+C");
  });

  it("a hotkey without Ctrl+Alt → shown as configured, no AltGr note", async () => {
    const { ctx, paths } = setup();
    write(paths.config, JSON.stringify({ hotkeys: { capture: "Control+Shift+F9" } }));
    const r = await install(ctx);
    const text = r.lines.join("\n");
    expect(text).toContain("Ctrl+Shift+F9");
    expect(text).not.toMatch(/AltGr/);
  });

  it("preflight failure → its problems as fail: lines, exit 1, nothing staged", async () => {
    const { ctx, calls, paths } = setup({
      preflight: { ok: false, problems: ["Node v20.0.0 is too old", "Claude Code not found"], claudePath: null },
    });
    const r = await install(ctx);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["fail: Node v20.0.0 is too old", "fail: Claude Code not found"]);
    expect(calls).toEqual(["preflight"]);
    expect(existsSync(paths.appRoot)).toBe(false);
  });

  it("preflight warnings → warn: lines, install goes on", async () => {
    const { ctx, calls } = setup({ preflight: { warnings: ["usage may bill to an API key"] } });
    const r = await install(ctx);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("warn: usage may bill to an API key");
    expect(calls.at(-1)).toBe("launch");
  });

  it("second install of the same version with the same Electron → quits the app first, no packaging", async () => {
    const { ctx, calls, paths } = setup();
    installed(paths, "0.2.0");
    const r = await install(ctx);
    expect(r.code).toBe(0);
    expect(calls).toEqual(["preflight", "quit", "stage", "current", "claudePath", "launch"]);
  });

  it("an install whose Electron version differs from the recorded one → packages again", async () => {
    const { ctx, calls, paths } = setup({ electron: "45.0.0" });
    installed(paths, "0.2.0", "44.7.2");
    await install(ctx);
    expect(calls).toContain("package");
    expect(readJson(path.join(paths.appRoot, "install.json")).electronVersion).toBe("45.0.0");
  });

  it("recorded install but the exe is gone → packages again", async () => {
    const { ctx, calls, paths } = setup();
    installed(paths, "0.2.0");
    await rm(paths.exe);
    await install(ctx);
    expect(calls).toContain("package");
  });

  it("a failing step → fail: line with its message, exit 1, no launch, no install.json", async () => {
    const { ctx, calls, paths } = setup({ stageError: new Error("npm ci --omit=dev failed (exit 1); its last lines:\nERR! 404") });
    const r = await install(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/^fail: npm ci --omit=dev failed[\s\S]*ERR! 404/m);
    expect(calls).not.toContain("launch");
    expect(existsSync(path.join(paths.appRoot, "install.json"))).toBe(false);
  });

  it("launch denied with EPERM → fail: naming the exe and the IT exclusion (Defender ASR), exit 1", async () => {
    const { ctx, paths } = setup({ launchError: spawnError("EPERM") });
    const r = await install(ctx);
    expect(r.code).toBe(1);
    const fail = r.lines.find((l) => l.startsWith("fail:"));
    expect(fail).toContain(paths.exe);
    expect(fail).toMatch(/Defender ASR/);
    expect(fail).toMatch(/IT/);
    expect(fail).toMatch(/exclusion/);
  });

  it("a claudePath warning is passed on as warn:", async () => {
    const { ctx, steps } = setup();
    steps.writeClaudePath.mockImplementationOnce(async ({ claudePath }: { claudePath: string }) => ({
      claudePath,
      warning: "config.json is not a JSON object, so it was left as it is",
    }));
    const r = await install(ctx);
    expect(r.lines).toContain("warn: config.json is not a JSON object, so it was left as it is");
  });
});

describe("start", () => {
  it("not installed → fail with the install hint, nothing launched", async () => {
    const { ctx, calls } = setup();
    const r = await start(ctx);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([expect.stringMatching(/^fail: .*\/snapsolve install/)]);
    expect(calls).toEqual([]);
  });

  it("install.json but no exe → fail with the install hint", async () => {
    const { ctx, calls, paths } = setup();
    installed(paths, "0.2.0");
    await rm(paths.exe);
    const r = await start(ctx);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/\/snapsolve install/);
    expect(calls).toEqual([]);
  });

  it("the recorded exe is a dangling link (its target deleted) → fail with the install hint, nothing launched (task 045)", async () => {
    const { ctx, calls, paths } = setup();
    installed(paths, "0.2.0");
    await rm(paths.exe);
    const gone = path.join(tmp, "gone-target");
    mkdirSync(gone, { recursive: true });
    symlinkSync(gone, paths.exe, "junction");
    await rm(gone, { recursive: true });
    expect(lstatSync(paths.exe).isSymbolicLink()).toBe(true);
    const r = await start(ctx);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([expect.stringMatching(/^fail: snapsolve is not installed: run \/snapsolve install/)]);
    expect(calls).toEqual([]);
  });

  it("installed → launches the recorded exe", async () => {
    const { ctx, steps, paths } = setup();
    installed(paths, "0.2.0");
    const r = await start(ctx);
    expect(r.code).toBe(0);
    expect(steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: paths.exe }));
    expect(kinds(r.lines)).toEqual(["ok"]);
  });

  it("launch denied with EPERM → the Defender ASR fail line", async () => {
    const { ctx, paths } = setup({ launchError: spawnError("EPERM") });
    installed(paths, "0.2.0");
    const r = await start(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/Defender ASR/);
  });
});

describe("update", () => {
  it("not installed → fail with the install hint, nothing run", async () => {
    const { ctx, calls } = setup();
    const r = await update(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/\/snapsolve install/);
    expect(calls).toEqual([]);
  });

  it("same version → up to date, no step runs", async () => {
    const { ctx, calls, paths } = setup({ pluginVersion: "0.2.0" });
    installed(paths, "0.2.0");
    const r = await update(ctx);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([expect.stringMatching(/^ok: .*0\.2\.0.*up to date/)]);
    expect(calls).toEqual([]);
  });

  it("installed pre-release of the plugin's version (0.2.0-beta.1 → 0.2.0) → updates (task 044)", async () => {
    const { ctx, calls, paths } = setup({ pluginVersion: "0.2.0" });
    installed(paths, "0.2.0-beta.1");
    const r = await update(ctx);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(calls).toEqual(["quit", "stage", "current", "launch"]);
    expect(readJson(path.join(paths.appRoot, "install.json")).version).toBe("0.2.0");
  });

  it("installed differs only by build metadata (0.2.0+b1 vs 0.2.0) → up to date, no step runs (task 044)", async () => {
    const { ctx, calls, paths } = setup({ pluginVersion: "0.2.0" });
    installed(paths, "0.2.0+b1");
    const r = await update(ctx);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([expect.stringMatching(/^ok: .*up to date/)]);
    expect(calls).toEqual([]);
  });

  it("new version, same Electron → quit before stage, no packaging, relaunch last", async () => {
    const { ctx, calls, paths } = setup({ pluginVersion: "0.2.0" });
    installed(paths, "0.1.0");
    const r = await update(ctx);
    expect(r.code).toBe(0);
    expect(calls).toEqual(["quit", "stage", "current", "launch"]);
    expect(readJson(path.join(paths.appRoot, "install.json"))).toEqual({ version: "0.2.0", electronVersion: "44.7.2", exe: paths.exe });
    expect(r.lines.join("\n")).toMatch(/0\.1\.0.*0\.2\.0/);
  });

  it("new version with a new Electron → packages between current and the relaunch", async () => {
    const { ctx, calls, paths } = setup({ pluginVersion: "0.2.0", electron: "45.0.0" });
    installed(paths, "0.1.0", "44.7.2");
    await update(ctx);
    expect(calls).toEqual(["quit", "stage", "current", "package", "launch"]);
  });

  it("keeps only the new and the previous version dirs; other entries are left alone", async () => {
    const { ctx, paths } = setup({ pluginVersion: "0.2.0" });
    write(path.join(paths.appRoot, "0.0.8", "main.js"), "old");
    write(path.join(paths.appRoot, "0.0.9", "main.js"), "old");
    installed(paths, "0.1.0");
    write(path.join(paths.appRoot, "notes.txt"), "mine");
    await update(ctx);
    expect(readdirSync(paths.appRoot).sort()).toEqual(["0.1.0", "0.2.0", "install.json", "notes.txt"]);
  });

  it("quit timeout → fail, nothing staged, install.json unchanged", async () => {
    const { ctx, calls, paths } = setup({
      pluginVersion: "0.2.0",
      quitError: new Error("C:\\P\\snapsolve.exe is still running 5 s after --quit"),
    });
    installed(paths, "0.1.0");
    const r = await update(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/^fail: .*still running/m);
    expect(calls).toEqual(["quit"]);
    expect(readJson(path.join(paths.appRoot, "install.json")).version).toBe("0.1.0");
  });
});

describe("uninstall", () => {
  function withHistory(paths: ReturnType<typeof setup>["paths"]) {
    installed(paths, "0.2.0");
    write(path.join(paths.data, "threads", "t1", "thread.json"), "{}");
    write(path.join(paths.data, "logs", "snapsolve.log"), "{}\n");
    write(paths.shortcut, "lnk");
  }

  it("only a dangling `current` junction left in the app dir → the app dir (and the junction) removed and reported (task 045)", async () => {
    const { ctx, paths } = setup();
    const gone = path.join(paths.appRoot, "0.1.0");
    mkdirSync(gone, { recursive: true });
    symlinkSync(gone, paths.current, "junction");
    await rm(gone, { recursive: true });
    const r = await uninstall(ctx, { purge: false });
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.lines).toContain(`ok: removed ${paths.appRoot}`);
    expect(existsSync(paths.appRoot)).toBe(false);
    expect(() => lstatSync(paths.current)).toThrow();
  });

  it("the launcher path is a dangling link → still removed and reported (removal targets count links, task 045)", async () => {
    const { ctx, paths } = setup();
    const gone = path.join(tmp, "gone-launcher");
    mkdirSync(gone, { recursive: true });
    mkdirSync(path.dirname(paths.programs), { recursive: true });
    symlinkSync(gone, paths.programs, "junction");
    await rm(gone, { recursive: true });
    const r = await uninstall(ctx, { purge: false });
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.lines).toContain(`ok: removed ${paths.programs}`);
    expect(() => lstatSync(paths.programs)).toThrow();
  });

  it("quits, removes the launcher, shortcut and app dir; keeps threads/, config.json and logs/", async () => {
    const { ctx, calls, paths } = setup();
    withHistory(paths);
    const r = await uninstall(ctx, { purge: false });
    expect(r.code).toBe(0);
    expect(calls).toEqual(["quit"]);
    expect(existsSync(paths.programs)).toBe(false);
    expect(existsSync(paths.shortcut)).toBe(false);
    expect(existsSync(paths.appRoot)).toBe(false);
    expect(readdirSync(paths.data).sort()).toEqual(["config.json", "logs", "threads"]);
    expect(r.lines.join("\n")).toMatch(/--purge/);
  });

  it("--purge → the whole data dir is gone too", async () => {
    const { ctx, paths } = setup();
    withHistory(paths);
    const r = await uninstall(ctx, { purge: true });
    expect(r.code).toBe(0);
    expect(existsSync(paths.data)).toBe(false);
    expect(existsSync(paths.programs)).toBe(false);
  });

  it("not installed → ok, nothing to remove, nothing quit", async () => {
    const { ctx, calls } = setup();
    const r = await uninstall(ctx, { purge: false });
    expect(r).toEqual({ code: 0, lines: [expect.stringMatching(/^ok: .*nothing to remove/)] });
    expect(calls).toEqual([]);
  });

  it("quit timeout → fail, nothing removed", async () => {
    const { ctx, paths } = setup({ quitError: new Error("still running 5 s after --quit") });
    withHistory(paths);
    const r = await uninstall(ctx, { purge: true });
    expect(r.code).toBe(1);
    expect(existsSync(paths.exe)).toBe(true);
    expect(existsSync(path.join(paths.appRoot, "install.json"))).toBe(true);
  });
});

describe("install.json write (writeState, task 045)", () => {
  const rename = vi.mocked(fsp.rename);
  const isStateTemp = (from: unknown) => /install\.json\..*\.tmp$/.test(String(from));

  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    rename.mockReset();
    rename.mockImplementation(actual.rename);
  });

  it("a transient EPERM on the rename is retried and install.json is still written", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let failures = 2;
    rename.mockImplementation(async (from, to) => {
      if (isStateTemp(from) && failures-- > 0) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return actual.rename(from, to);
    });
    const { ctx, paths } = setup();
    const r = await install(ctx);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(rename.mock.calls.filter(([from]) => isStateTemp(from))).toHaveLength(3);
    expect(readJson(path.join(paths.appRoot, "install.json"))).toEqual({ version: "0.2.0", electronVersion: "44.7.2", exe: paths.exe });
    expect(readdirSync(paths.appRoot).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a non-transient rename error (ENOSPC) is not retried and fails the install", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    rename.mockImplementation(async (from, to) => {
      if (isStateTemp(from)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return actual.rename(from, to);
    });
    const { ctx, paths } = setup();
    const r = await install(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/ENOSPC/);
    expect(rename.mock.calls.filter(([from]) => isStateTemp(from))).toHaveLength(1);
    expect(existsSync(path.join(paths.appRoot, "install.json"))).toBe(false);
  });
});

describe("doctor", () => {
  function healthy(options: Options = {}) {
    const s = setup(options);
    const claude = path.join(tmp, "bin", "claude.exe");
    write(claude, "binary");
    installed(s.paths, "0.2.0", "44.7.2", claude);
    return s;
  }

  it("all healthy → only ok: lines, exit 0; the smoke check runs the installed exe", async () => {
    const { ctx, steps, paths } = healthy();
    const r = await doctor(ctx);
    expect(r.code).toBe(0);
    expect(kinds(r.lines).every((k) => k === "ok")).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("2.1.300 (Claude Code)");
    expect(text).toContain("v22.12.0");
    expect(text).toContain("0.2.0");
    expect(steps.asrCheck).toHaveBeenCalledWith(expect.objectContaining({ exe: paths.exe }));
  });

  describe("installed vs plugin version (task 044)", () => {
    function at(version: string) {
      const s = setup({ pluginVersion: "0.2.0" });
      const claude = path.join(tmp, "bin", "claude.exe");
      write(claude, "binary");
      installed(s.paths, version, "44.7.2", claude);
      return s;
    }
    const versionLine = (lines: string[]) => lines.find((l) => /installed/.test(l) && /snapsolve /.test(l)) ?? "";

    it("0.2.0-beta.1 installed, plugin 0.2.0 → warn naming /snapsolve update", async () => {
      const r = await doctor(at("0.2.0-beta.1").ctx);
      const line = versionLine(r.lines);
      expect(line).toMatch(/^warn: /);
      expect(line).toContain("/snapsolve update");
      expect(line).not.toMatch(/newer/);
    });

    it("0.3.0 installed, plugin 0.2.0 → warn: newer", async () => {
      const r = await doctor(at("0.3.0").ctx);
      expect(versionLine(r.lines)).toMatch(/^warn: .*newer/);
    });

    it("0.2.0+b1 installed, plugin 0.2.0 → ok (the plugin's version)", async () => {
      const r = await doctor(at("0.2.0+b1").ctx);
      expect(versionLine(r.lines)).toMatch(/^ok: .*the plugin's version/);
    });

    it("an unparsable installed version → warn that it cannot compare, naming /snapsolve update, not newer", async () => {
      const r = await doctor(at("dev-build").ctx);
      const line = r.lines.find((l) => l.includes("dev-build")) ?? "";
      expect(line).toMatch(/^warn: .*cannot compare/);
      expect(line).toContain("/snapsolve update");
      expect(line).not.toMatch(/newer/);
    });
  });

  it("ASR blocked → fail: naming the exe and the IT exclusion, exit 1", async () => {
    const { ctx, paths } = healthy({ asr: { status: "blocked", output: "spawn EPERM" } });
    const r = await doctor(ctx);
    expect(r.code).toBe(1);
    const fail = r.lines.filter((l) => l.startsWith("fail:"));
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain(`Defender ASR blocks ${paths.exe}`);
    expect(fail[0]).toMatch(/ask IT for an exclusion/);
  });

  it("smoke check failed → fail: with its output", async () => {
    const { ctx } = healthy({ asr: { status: "failed", output: "exit 1: Cannot find module" } });
    const r = await doctor(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/^fail: .*Cannot find module/m);
  });

  it("installed version older than the plugin → warn: suggesting /snapsolve update, still exit 0", async () => {
    const { ctx } = healthy({ pluginVersion: "0.3.0" });
    const r = await doctor(ctx);
    expect(r.code).toBe(0);
    expect(r.lines).toContainEqual(expect.stringMatching(/^warn: .*0\.2\.0.*0\.3\.0.*\/snapsolve update/));
  });

  it("not installed → fail with the install hint, no smoke check", async () => {
    const { ctx, steps } = setup();
    const r = await doctor(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/^fail: .*\/snapsolve install/m);
    expect(steps.asrCheck).not.toHaveBeenCalled();
  });

  it("preflight problems and warnings → fail: and warn: lines", async () => {
    const { ctx } = healthy({
      preflight: { ok: false, problems: ["Node v20.0.0 is too old: snapsolve needs Node ≥ 22.12"], warnings: ["may bill to an API key"] },
    });
    const r = await doctor(ctx);
    expect(r.code).toBe(1);
    expect(r.lines).toContain("fail: Node v20.0.0 is too old: snapsolve needs Node ≥ 22.12");
    expect(r.lines).toContain("warn: may bill to an API key");
    expect(r.lines.join("\n")).not.toMatch(/^ok: Node/m);
  });

  it("config claudePath pointing at a missing file → fail; null → warn", async () => {
    const missing = healthy();
    write(missing.paths.config, JSON.stringify({ claudePath: path.join(tmp, "gone", "claude.exe") }));
    const r1 = await doctor(missing.ctx);
    expect(r1.code).toBe(1);
    expect(r1.lines.join("\n")).toMatch(/^fail: .*claudePath/m);

    write(missing.paths.config, JSON.stringify({ claudePath: null }));
    const r2 = await doctor(missing.ctx);
    expect(r2.lines.join("\n")).toMatch(/^warn: .*claudePath/m);
  });

  it("exe missing → fail, no smoke check", async () => {
    const { ctx, steps, paths } = healthy();
    await rm(paths.exe);
    const r = await doctor(ctx);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain(paths.exe);
    expect(steps.asrCheck).not.toHaveBeenCalled();
  });
});

describe("macOS (M3, task 031)", () => {
  it("install: same flow; launch and quit get the platform; Ctrl+Option+C, Screen Recording + Relaunch, no AltGr note", async () => {
    const { ctx, calls, paths, steps } = setup({ platform: "darwin" });
    const r = await install(ctx);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(calls).toEqual(["preflight", "stage", "current", "package", "claudePath", "launch"]);
    expect(steps.packageBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ programs: paths.programs, shortcut: null, platform: "darwin" }),
    );
    expect(steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: paths.exe, platform: "darwin" }));
    expect(steps.writeClaudePath).toHaveBeenCalledWith(expect.objectContaining({ configFile: paths.config, platform: "darwin" }));
    const text = r.lines.join("\n");
    expect(text).toContain("Ctrl+Option+C");
    expect(text).toMatch(/Screen Recording/);
    expect(text).toMatch(/Relaunch/);
    expect(text).not.toMatch(/AltGr/);
    expect(kinds(r.lines).every((k) => k === "ok")).toBe(true);
  });

  it("Windows install says nothing about Screen Recording", async () => {
    const { ctx } = setup();
    const r = await install(ctx);
    expect(r.lines.join("\n")).not.toMatch(/Screen Recording/);
  });

  it("update with the same Electron → no packaging (so no re-signing) and no Screen Recording warning", async () => {
    const { ctx, calls, paths, steps } = setup({ platform: "darwin", pluginVersion: "0.2.0" });
    installed(paths, "0.1.0");
    const r = await update(ctx);
    expect(r.code).toBe(0);
    expect(calls).toEqual(["quit", "stage", "current", "launch"]);
    expect(steps.quitAndWait).toHaveBeenCalledWith(expect.objectContaining({ exe: paths.exe, platform: "darwin" }));
    expect(r.lines.join("\n")).not.toMatch(/Screen Recording/);
  });

  it("update with a new Electron → packaged (and re-signed) plus a warn: that macOS asks for Screen Recording again", async () => {
    const { ctx, calls, paths } = setup({ platform: "darwin", pluginVersion: "0.2.0", electron: "45.0.0" });
    installed(paths, "0.1.0", "44.7.2");
    const r = await update(ctx);
    expect(r.code).toBe(0);
    expect(calls).toEqual(["quit", "stage", "current", "package", "launch"]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^warn: .*Screen Recording/));
  });

  it("reinstall with a new Electron → the same Screen Recording warning; a first install has none", async () => {
    const again = setup({ platform: "darwin", electron: "45.0.0" });
    installed(again.paths, "0.2.0", "44.7.2");
    const r = await install(again.ctx);
    expect(r.lines).toContainEqual(expect.stringMatching(/^warn: .*Screen Recording/));
  });

  it("uninstall removes the .app bundle and the app dir, keeps history; there is no shortcut to remove", async () => {
    const { ctx, paths } = setup({ platform: "darwin" });
    installed(paths, "0.2.0");
    write(path.join(paths.data, "threads", "t1", "thread.json"), "{}");
    const r = await uninstall(ctx, { purge: false });
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(existsSync(paths.programs)).toBe(false);
    expect(existsSync(paths.appRoot)).toBe(false);
    expect(readdirSync(paths.data).sort()).toEqual(["config.json", "threads"]);
  });

  it("doctor checks the Mac install like the Windows one (all ok when healthy)", async () => {
    const { ctx, paths, steps } = setup({ platform: "darwin" });
    const claude = path.join(tmp, "bin", "claude");
    write(claude, "binary");
    installed(paths, "0.2.0", "44.7.2", claude);
    const r = await doctor(ctx);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(kinds(r.lines).every((k) => k === "ok")).toBe(true);
    expect(steps.asrCheck).toHaveBeenCalledWith(expect.objectContaining({ exe: paths.exe }));
  });
});

describe("CLI arguments", () => {
  it("each command parses; --purge only with uninstall", () => {
    for (const command of ["install", "start", "update", "doctor", "uninstall"]) {
      expect(parseArgs([command])).toEqual({ command, purge: false });
    }
    expect(parseArgs(["uninstall", "--purge"])).toEqual({ command: "uninstall", purge: true });
  });

  for (const argv of [[], ["foo"], ["install", "--purge"], ["doctor", "--purge"], ["uninstall", "--force"], ["install", "extra"]]) {
    it(`${JSON.stringify(argv)} → usage`, () => {
      expect(parseArgs(argv)).toEqual({ usage: expect.stringMatching(/install \| start \| update \| doctor \| uninstall/) });
    });
  }

  it("the CLI prints the usage and exits 2 for no command or an unknown one", () => {
    for (const argv of [[], ["foo"], ["start", "--purge"]]) {
      const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
      expect(r.status, JSON.stringify(argv)).toBe(2);
      expect(r.stdout).toMatch(/usage/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// task 036: a failure after the quit restarts the previous version; the CLI's test hooks are inert by default

/** Points `<appRoot>/current` at `<appRoot>/<version>` (a junction on Windows), replacing an existing link. */
function linkCurrent(paths: ReturnType<typeof setup>["paths"], version: string): void {
  try {
    if (lstatSync(paths.current).isSymbolicLink()) unlinkSync(paths.current);
  } catch {
    // no link yet
  }
  symlinkSync(path.join(paths.appRoot, version), paths.current, "junction");
}

const currentTarget = (paths: ReturnType<typeof setup>["paths"]) => realpathSync(paths.current);

/** An existing install of `version` whose `current` link points at it, so a restart can run it. */
function installedWithCurrent(s: ReturnType<typeof setup>, version: string, electron = "44.7.2") {
  installed(s.paths, version, electron);
  linkCurrent(s.paths, version);
  // The fake pointCurrent flips the real link, like the real step.
  s.steps.pointCurrent.mockImplementation(async ({ version: v }: { version: string }) => {
    s.calls.push("current");
    linkCurrent(s.paths, v);
  });
}

describe("update: a failure after the quit restarts the previous version", () => {
  it("stage throws → fail: with the stage error, then the old exe is relaunched with a warn: about the restart; exit 1", async () => {
    const s = setup({ pluginVersion: "0.2.0", stageError: new Error("npm ci --omit=dev failed (exit 1): ERR! 404") });
    installedWithCurrent(s, "0.1.0");
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["quit", "stage", "launch"]);
    expect(s.steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: s.paths.exe, env: s.ctx.env, platform: "win32" }));
    expect(r.lines).toEqual([
      expect.stringMatching(/^fail: npm ci --omit=dev failed.*ERR! 404/),
      expect.stringMatching(/^warn: .*restarted.*0\.1\.0/),
    ]);
    expect(readJson(path.join(s.paths.appRoot, "install.json")).version).toBe("0.1.0");
  });

  it("the relaunch uses the exe recorded in install.json, not the default path", async () => {
    const s = setup({ pluginVersion: "0.2.0", stageError: new Error("disk full") });
    installedWithCurrent(s, "0.1.0");
    const oldExe = path.join(tmp, "Old Programs", "snapsolve.exe");
    write(oldExe, "old exe");
    write(path.join(s.paths.appRoot, "install.json"), JSON.stringify({ version: "0.1.0", electronVersion: "44.7.2", exe: oldExe }));
    await update(s.ctx);
    expect(s.steps.launch).toHaveBeenCalledTimes(1);
    expect(s.steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: oldExe }));
  });

  // 041: was "names /snapsolve start", but `start` without an exe only answers "not installed: run /snapsolve install".
  it("stage throws and the old exe is gone → no launch; the fail: text names /snapsolve install, not /snapsolve start", async () => {
    const s = setup({ pluginVersion: "0.2.0", stageError: new Error("disk full") });
    installedWithCurrent(s, "0.1.0");
    await rm(s.paths.exe);
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).not.toContain("launch");
    expect(r.lines[0]).toMatch(/^fail: disk full/);
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve install/));
    expect(r.lines.join("\n")).not.toMatch(/\/snapsolve start|restarted/);
  });

  it("macOS: the old bundle binary is gone → no launch; the fail: text names /snapsolve install, not /snapsolve start", async () => {
    const s = setup({ platform: "darwin", pluginVersion: "0.2.0", stageError: new Error("disk full") });
    installedWithCurrent(s, "0.1.0");
    await rm(s.paths.exe);
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).not.toContain("launch");
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve install/));
    expect(r.lines.join("\n")).not.toMatch(/\/snapsolve start|restarted/);
  });

  it("pointCurrent throws before the link moved → current still at the old version, so it is restarted", async () => {
    const s = setup({ pluginVersion: "0.2.0" });
    installedWithCurrent(s, "0.1.0");
    s.steps.pointCurrent.mockImplementation(async () => {
      s.calls.push("current");
      throw new Error("cannot point current: EBUSY");
    });
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["quit", "stage", "current", "launch"]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^warn: .*restarted.*0\.1\.0/));
  });

  it("packaging fails after current moved to the new version → no restart of the old launcher; the fail: says to run /snapsolve update again", async () => {
    const s = setup({ pluginVersion: "0.2.0", electron: "45.0.0" });
    installedWithCurrent(s, "0.1.0", "44.7.2");
    s.steps.packageBootstrap.mockImplementation(async () => {
      s.calls.push("package");
      throw new Error("@electron/packager: download failed: ETIMEDOUT");
    });
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["quit", "stage", "current", "package"]);
    expect(currentTarget(s.paths)).toBe(realpathSync(path.join(s.paths.appRoot, "0.2.0")));
    expect(r.lines[0]).toMatch(/^fail: .*ETIMEDOUT/);
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve update again/));
    expect(r.lines.join("\n")).not.toMatch(/restarted/);
    expect(readJson(path.join(s.paths.appRoot, "install.json")).version).toBe("0.1.0");
  });

  it("the relaunch itself is denied (EPERM) → the Defender ASR fail: line and the /snapsolve start line, no restart warn:", async () => {
    const s = setup({ pluginVersion: "0.2.0", stageError: new Error("disk full"), launchError: spawnError("EPERM") });
    installedWithCurrent(s, "0.1.0");
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["quit", "stage", "launch"]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: Defender ASR blocks/));
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve start/));
    expect(r.lines.join("\n")).not.toMatch(/restarted|\/snapsolve install/);
  });

  it("quit itself fails → no relaunch attempt (the app is still running), no restart text", async () => {
    const s = setup({ pluginVersion: "0.2.0", quitError: new Error("C:\\P\\snapsolve.exe is still running 5 s after --quit") });
    installedWithCurrent(s, "0.1.0");
    const r = await update(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["quit"]);
    expect(r.lines).toEqual([expect.stringMatching(/^fail: .*still running/)]);
  });

  it("a successful update is unchanged: one launch (the new version), no restart text", async () => {
    const s = setup({ pluginVersion: "0.2.0" });
    installedWithCurrent(s, "0.1.0");
    const r = await update(s.ctx);
    expect(r.code).toBe(0);
    expect(s.calls).toEqual(["quit", "stage", "current", "launch"]);
    expect(kinds(r.lines).every((k) => k === "ok")).toBe(true);
    expect(r.lines.join("\n")).not.toMatch(/previous|not running/);
  });

  it("macOS: the restart goes through launch with the platform", async () => {
    const s = setup({ platform: "darwin", pluginVersion: "0.2.0", stageError: new Error("disk full") });
    installedWithCurrent(s, "0.1.0");
    const r = await update(s.ctx);
    expect(s.steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: s.paths.exe, platform: "darwin" }));
    expect(r.lines).toContainEqual(expect.stringMatching(/^warn: .*restarted.*0\.1\.0/));
  });
});

describe("install over an existing install: a failure after the quit restarts the previous version", () => {
  it("stage throws → fail: with the stage error, the old exe relaunched, a warn: about the restart; exit 1", async () => {
    const s = setup({ stageError: new Error("npm ci --omit=dev failed (exit 1): ERR! 404") });
    installedWithCurrent(s, "0.1.0");
    const r = await install(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["preflight", "quit", "stage", "launch"]);
    expect(s.steps.launch).toHaveBeenCalledWith(expect.objectContaining({ exe: s.paths.exe }));
    expect(r.lines).toEqual([
      expect.stringMatching(/^fail: npm ci --omit=dev failed.*ERR! 404/),
      expect.stringMatching(/^warn: .*restarted.*0\.1\.0/),
    ]);
    expect(readJson(path.join(s.paths.appRoot, "install.json")).version).toBe("0.1.0");
  });

  // 041: was "names /snapsolve start", but `start` without an exe only answers "not installed: run /snapsolve install".
  it("stage throws and the old exe is gone → no launch; the fail: text names /snapsolve install, not /snapsolve start", async () => {
    const s = setup({ stageError: new Error("disk full") });
    installedWithCurrent(s, "0.1.0");
    await rm(s.paths.exe);
    const r = await install(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).not.toContain("launch");
    expect(r.lines[0]).toMatch(/^fail: disk full/);
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve install/));
    expect(r.lines.join("\n")).not.toMatch(/\/snapsolve start|restarted/);
  });

  it("the relaunch itself is denied (EPERM) → the Defender ASR fail: line and the /snapsolve start line (the exe is there)", async () => {
    const s = setup({ stageError: new Error("disk full"), launchError: spawnError("EPERM") });
    installedWithCurrent(s, "0.1.0");
    const r = await install(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["preflight", "quit", "stage", "launch"]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: Defender ASR blocks/));
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve start/));
    expect(r.lines.join("\n")).not.toMatch(/restarted|\/snapsolve install/);
  });

  it("writing claudePath fails after current moved → no restart; the fail: says to run /snapsolve install again", async () => {
    const s = setup({ pluginVersion: "0.2.0" });
    installedWithCurrent(s, "0.1.0");
    s.steps.writeClaudePath.mockImplementation(async () => {
      s.calls.push("claudePath");
      throw new Error("config.json: EACCES");
    });
    const r = await install(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["preflight", "quit", "stage", "current", "claudePath"]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^fail: .*not running.*\/snapsolve install again/));
  });

  it("a first install that fails restarts nothing and says nothing about a restart (nothing was quit)", async () => {
    const s = setup({ stageError: new Error("disk full") });
    const r = await install(s.ctx);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual(["preflight", "stage"]);
    expect(r.lines).toEqual([expect.stringMatching(/^fail: disk full/)]);
  });
});

describe("CLI test hooks (realSteps.mjs)", () => {
  const FAKE = path.join("C:\\", "t", "fake-claude.mjs");

  /** The steps module's shape, every function a recording fake. */
  function base() {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const step = () => vi.fn(async () => ({}));
    return {
      run,
      preflight: step(),
      stageVersion: step(),
      pointCurrent: step(),
      packageBootstrap: step(),
      writeClaudePath: step(),
      launch: step(),
      quitAndWait: step(),
      asrCheck: step(),
    };
  }

  type Exec = (...a: unknown[]) => Promise<unknown>;
  const firstArg = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

  async function wire(env: Record<string, string>) {
    const { realSteps } = await import("../../plugin/skills/snapsolve/scripts/realSteps.mjs");
    const b = base();
    return { b, w: realSteps(env, b) };
  }

  for (const test of [undefined, "0", "true", "yes"]) {
    it(`SNAPSOLVE_TEST=${JSON.stringify(test)} with the hook variables set → claude.exe runs as itself, launch spawns, isRunning is the real one`, async () => {
      const launchLog = path.join(tmp, "launches.log");
      const env: Record<string, string> = { SNAPSOLVE_TEST_CLAUDE: FAKE, SNAPSOLVE_TEST_LAUNCH_LOG: launchLog };
      if (test !== undefined) env.SNAPSOLVE_TEST = test;
      const { b, w } = await wire(env);

      await w.preflight({ platform: "win32" });
      await w.stageVersion({ source: "s" });
      await w.packageBootstrap({ versionDir: "v" });
      await w.asrCheck({ exe: "C:\\P\\snapsolve.exe" });
      await w.quitAndWait({ exe: "C:\\P\\snapsolve.exe", platform: "win32" });
      for (const fn of [b.preflight, b.stageVersion, b.packageBootstrap, b.asrCheck, b.quitAndWait]) {
        expect(firstArg(fn)).toEqual(expect.objectContaining({ exec: b.run }));
      }
      // No isRunning override: quitAndWait's default (tasklist / pgrep) decides.
      expect(firstArg(b.quitAndWait)).not.toHaveProperty("isRunning");

      const exec = firstArg(b.preflight).exec as Exec;
      await exec("C:\\Users\\e\\.local\\bin\\claude.exe", ["--version"], { timeoutMs: 1 });
      expect(b.run).toHaveBeenLastCalledWith("C:\\Users\\e\\.local\\bin\\claude.exe", ["--version"], { timeoutMs: 1 });

      const launchArgs = { exe: "C:\\P\\snapsolve.exe", env: {}, platform: "win32" };
      await w.launch(launchArgs);
      expect(b.launch).toHaveBeenCalledWith(launchArgs);
      expect(existsSync(launchLog)).toBe(false);
    });
  }

  it("SNAPSOLVE_TEST=1 → claude.exe (any case) runs the fake script with node, other commands run as themselves, launch is logged, nothing runs", async () => {
    const launchLog = path.join(tmp, "launches.log");
    const { b, w } = await wire({ SNAPSOLVE_TEST: "1", SNAPSOLVE_TEST_CLAUDE: FAKE, SNAPSOLVE_TEST_LAUNCH_LOG: launchLog });

    await w.preflight({ platform: "win32" });
    const exec = firstArg(b.preflight).exec as Exec;
    expect(exec).not.toBe(b.run);
    await exec("C:\\Users\\e\\.local\\bin\\CLAUDE.EXE", ["auth", "status"], { timeoutMs: 1 });
    expect(b.run).toHaveBeenLastCalledWith(process.execPath, [FAKE, "auth", "status"], { timeoutMs: 1 });
    await exec("npm", ["ci"], { shell: true });
    expect(b.run).toHaveBeenLastCalledWith("npm", ["ci"], { shell: true });

    await w.launch({ exe: "C:\\P\\snapsolve.exe", env: {}, platform: "win32" });
    expect(b.launch).not.toHaveBeenCalled();
    expect(readFileSync(launchLog, "utf8")).toBe("C:\\P\\snapsolve.exe\n");

    await w.quitAndWait({ exe: "C:\\P\\snapsolve.exe", platform: "win32" });
    const isRunning = firstArg(b.quitAndWait).isRunning as () => Promise<boolean>;
    expect(await isRunning()).toBe(false);
  });

  it("SNAPSOLVE_TEST=1 → only a file named claude.exe (either slash style) runs the fake, on any host OS", async () => {
    const { b, w } = await wire({ SNAPSOLVE_TEST: "1", SNAPSOLVE_TEST_CLAUDE: FAKE });
    await w.preflight({ platform: "win32" });
    const exec = firstArg(b.preflight).exec as Exec;
    for (const claude of ["C:\\Users\\e\\.local\\bin\\claude.exe", "C:/Users/e/.local/bin/Claude.Exe", "/c/Users/e/claude.exe"]) {
      await exec(claude, ["--version"], { timeoutMs: 1 });
      expect(b.run).toHaveBeenLastCalledWith(process.execPath, [FAKE, "--version"], { timeoutMs: 1 });
    }
    for (const other of ["C:\\bin\\claude.exe.bak", "C:\\bin\\notclaude.exe", "/usr/local/bin/claude", "claude"]) {
      await exec(other, ["--version"], { timeoutMs: 1 });
      expect(b.run).toHaveBeenLastCalledWith(other, ["--version"], { timeoutMs: 1 });
    }
  });

  it("SNAPSOLVE_TEST=1 with no hook variables → the real exec, launch and isRunning", async () => {
    const { b, w } = await wire({ SNAPSOLVE_TEST: "1" });
    await w.preflight({ platform: "win32" });
    await w.quitAndWait({ exe: "C:\\P\\snapsolve.exe", platform: "win32" });
    await w.launch({ exe: "C:\\P\\snapsolve.exe" });
    expect(firstArg(b.preflight)).toEqual(expect.objectContaining({ exec: b.run }));
    expect(firstArg(b.quitAndWait)).not.toHaveProperty("isRunning");
    expect(b.launch).toHaveBeenCalledTimes(1);
  });

  it("the CLI builds its steps with realSteps from realSteps.mjs (no wiring of its own)", () => {
    const cli = readFileSync(CLI, "utf8");
    expect(cli).toMatch(/import \{ realSteps \} from "\.\/realSteps\.mjs";/);
    expect(cli).toMatch(/steps: realSteps\(env\)/);
    expect(cli).not.toMatch(/function realSteps/);
  });
});

describe("doctor smoke check on macOS (039)", () => {
  function healthyMac(asr: { status: string; output: string }) {
    const s = setup({ platform: "darwin", asr });
    const claude = path.join(tmp, "bin", "claude");
    write(claude, "binary");
    installed(s.paths, "0.2.0", "44.7.2", claude);
    return s;
  }

  it("a blocked smoke check (spawn EPERM) → fail: naming the exe and the EPERM, the reinstall fix, no Defender/ASR text; exit 1", async () => {
    const s = healthyMac({ status: "blocked", output: `spawn EPERM: ${path.join(tmp, "x")}` });
    const r = await doctor(s.ctx);
    expect(r.code).toBe(1);
    const fail = r.lines.filter((l) => l.startsWith("fail:"));
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain(s.paths.exe);
    expect(fail[0]).toContain("EPERM");
    expect(fail[0]).toContain("/snapsolve install");
    expect(r.lines.join("\n")).not.toMatch(/Defender|ASR|ask IT/);
  });

  it("a failed smoke check → the generic --smoke failed: line, unchanged", async () => {
    const s = healthyMac({ status: "failed", output: "exit 1: Cannot find module" });
    const r = await doctor(s.ctx);
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("fail:"))).toEqual([`fail: ${s.paths.exe} --smoke failed: exit 1: Cannot find module`]);
  });

  it("Windows keeps exactly the Defender ASR line for a blocked smoke check", async () => {
    const s = setup({ asr: { status: "blocked", output: "spawn EPERM" } });
    const claude = path.join(tmp, "bin", "claude.exe");
    write(claude, "binary");
    installed(s.paths, "0.2.0", "44.7.2", claude);
    const r = await doctor(s.ctx);
    expect(r.lines.filter((l) => l.startsWith("fail:"))).toEqual([
      `fail: Defender ASR blocks ${s.paths.exe}; ask IT for an exclusion for it.`,
    ]);
  });
});
