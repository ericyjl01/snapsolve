import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataPaths, resolveDataDir } from "../../src/main/paths";
import { repoRoot } from "../paths";

type Env = Record<string, string | undefined>;
interface BootDeps {
  resolve: () => string;
  exists: (file: string) => boolean;
  load: (file: string) => unknown;
  showError: (title: string, content: string) => void;
  exit: (code: number) => void;
}
interface BootModule {
  resolveEntry(platform: NodeJS.Platform, env: Env, home: string): string;
  boot(deps: BootDeps): void;
}

const BOOT_JS = path.join(repoRoot, "bootstrap", "boot.js");
const require = createRequire(import.meta.url);
const { resolveEntry, boot } = require(BOOT_JS) as BootModule;

const WIN_LOCAL = "C:\\Users\\eric\\AppData\\Local";
const WIN_HOME = "C:\\Users\\eric";

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

/** The entry the installed app must have, derived from the app's own paths.ts. */
function appEntry(platform: NodeJS.Platform, env: Env, home: string): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dir = resolveDataDir(platform, env, home);
  const appSubdir = path.relative(dir, dataPaths(dir).app);
  return p.join(dir, appSubdir, "current", "main.js");
}

describe("resolveEntry", () => {
  it("win32 → %LOCALAPPDATA%\\snapsolve\\app\\current\\main.js", () => {
    expect(resolveEntry("win32", { LOCALAPPDATA: WIN_LOCAL }, WIN_HOME)).toBe(
      "C:\\Users\\eric\\AppData\\Local\\snapsolve\\app\\current\\main.js",
    );
  });

  it("darwin → ~/Library/Application Support/snapsolve/app/current/main.js", () => {
    expect(resolveEntry("darwin", {}, "/Users/eric")).toBe("/Users/eric/Library/Application Support/snapsolve/app/current/main.js");
  });

  it.each<[string, NodeJS.Platform, Env, string]>([
    ["win32 default", "win32", { LOCALAPPDATA: WIN_LOCAL }, WIN_HOME],
    ["win32 override", "win32", { SNAPSOLVE_DATA_DIR: "D:\\tmp\\ss", LOCALAPPDATA: WIN_LOCAL }, WIN_HOME],
    ["win32 override normalized", "win32", { SNAPSOLVE_DATA_DIR: "D:\\tmp\\x\\..\\ss\\", LOCALAPPDATA: WIN_LOCAL }, WIN_HOME],
    ["win32 empty override = unset", "win32", { SNAPSOLVE_DATA_DIR: "", LOCALAPPDATA: WIN_LOCAL }, WIN_HOME],
    ["darwin default", "darwin", {}, "/Users/eric"],
    ["darwin override", "darwin", { SNAPSOLVE_DATA_DIR: "/tmp/ss" }, "/Users/eric"],
    ["linux override (tests)", "linux", { SNAPSOLVE_DATA_DIR: "/tmp/ss" }, "/home/eric"],
  ])("matches the app's paths.ts: %s", (_name, platform, env, home) => {
    expect(resolveEntry(platform, env, home)).toBe(appEntry(platform, env, home));
  });

  it.each<[string, NodeJS.Platform, Env, string, string]>([
    ["relative override", "win32", { SNAPSOLVE_DATA_DIR: "tmp\\ss", LOCALAPPDATA: WIN_LOCAL }, WIN_HOME, "tmp\\ss"],
    ["missing LOCALAPPDATA", "win32", {}, WIN_HOME, "LOCALAPPDATA"],
    ["relative LOCALAPPDATA", "win32", { LOCALAPPDATA: "AppData\\Local" }, WIN_HOME, "AppData\\Local"],
    ["relative home on darwin", "darwin", {}, "Users/eric", "Users/eric"],
    ["linux without override", "linux", {}, "/home/eric", "linux"],
  ])("throws instead of guessing, like paths.ts: %s", (_name, platform, env, home, named) => {
    expect(() => resolveDataDir(platform, env, home)).toThrow();
    expect(thrown(() => resolveEntry(platform, env, home)).message).toContain(named);
  });
});

describe("boot", () => {
  const ENTRY = "C:\\Users\\eric\\AppData\\Local\\snapsolve\\app\\current\\main.js";

  function deps(over: Partial<BootDeps> = {}) {
    const d = {
      resolve: vi.fn(() => ENTRY),
      exists: vi.fn(() => true),
      load: vi.fn(),
      showError: vi.fn(),
      exit: vi.fn(),
      ...over,
    };
    return d;
  }

  it("runs the installed app: loads the entry once, no error, no exit", () => {
    const d = deps();
    boot(d);
    expect(d.exists).toHaveBeenCalledWith(ENTRY);
    expect(d.load).toHaveBeenCalledTimes(1);
    expect(d.load).toHaveBeenCalledWith(ENTRY);
    expect(d.showError).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("entry missing → error box naming /snapsolve install and the path, exit 1, nothing loaded", () => {
    const d = deps({ exists: vi.fn(() => false) });
    boot(d);
    expect(d.load).not.toHaveBeenCalled();
    expect(d.showError).toHaveBeenCalledTimes(1);
    const [title, content] = d.showError.mock.calls[0];
    expect(title).toMatch(/snapsolve/i);
    expect(content).toContain("/snapsolve install");
    expect(content).toContain(ENTRY);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it("entry throws while loading → error box with the error message, exit 1", () => {
    const d = deps({
      load: vi.fn(() => {
        throw new Error("boom: bad main.js");
      }),
    });
    boot(d);
    expect(d.showError).toHaveBeenCalledTimes(1);
    const content = d.showError.mock.calls[0][1];
    expect(content).toContain("boom: bad main.js");
    expect(content).toContain("/snapsolve install");
    expect(content).toContain(ENTRY);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it("data dir unresolvable → error box with the reason, exit 1, nothing checked or loaded", () => {
    const d = deps({
      resolve: vi.fn(() => {
        throw new Error("LOCALAPPDATA is not an absolute path");
      }),
    });
    boot(d);
    expect(d.exists).not.toHaveBeenCalled();
    expect(d.load).not.toHaveBeenCalled();
    expect(d.showError.mock.calls[0][1]).toContain("LOCALAPPDATA is not an absolute path");
    expect(d.exit).toHaveBeenCalledWith(1);
  });
});

describe("bootstrap package", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loading boot.js outside Electron has no side effects", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    delete require.cache[require.resolve(BOOT_JS)];
    const mod = require(BOOT_JS) as BootModule;
    expect(typeof mod.boot).toBe("function");
    expect(typeof mod.resolveEntry).toBe("function");
    expect(exit).not.toHaveBeenCalled();
    // No Electron access: the electron package was never loaded (a top-level require("electron") would be).
    const electronDir = `${path.sep}node_modules${path.sep}electron${path.sep}`;
    expect(Object.keys(require.cache).filter((k) => k.includes(electronDir))).toEqual([]);
  });

  it("boot.js uses only path, fs, os and electron", () => {
    const src = readFileSync(BOOT_JS, "utf8");
    const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    expect(new Set(required)).toEqual(new Set(required.filter((r) => ["path", "fs", "os", "electron"].includes(r))));
    expect(required).toContain("electron");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("package.json: snapsolve, main boot.js, no dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "bootstrap", "package.json"), "utf8"));
    expect(pkg.name).toBe("snapsolve");
    expect(pkg.productName).toBe("snapsolve");
    expect(pkg.main).toBe("boot.js");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });
});
