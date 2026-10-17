import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, ensureDirs, resolveDataDir } from "../../src/main/paths";
import { SnapsolveError } from "../../src/shared/errors";

const WIN_LOCAL = "C:\\Users\\eric\\AppData\\Local";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("resolveDataDir", () => {
  it("SNAPSOLVE_DATA_DIR wins on every platform", () => {
    expect(resolveDataDir("win32", { SNAPSOLVE_DATA_DIR: "D:\\tmp\\ss", LOCALAPPDATA: WIN_LOCAL }, "C:\\Users\\eric")).toBe(
      "D:\\tmp\\ss",
    );
    expect(resolveDataDir("darwin", { SNAPSOLVE_DATA_DIR: "/tmp/ss" }, "/Users/eric")).toBe("/tmp/ss");
    // Lets tests run on platforms the app does not ship for.
    expect(resolveDataDir("linux", { SNAPSOLVE_DATA_DIR: "/tmp/ss" }, "/home/eric")).toBe("/tmp/ss");
  });

  it("an empty SNAPSOLVE_DATA_DIR counts as unset", () => {
    expect(resolveDataDir("win32", { SNAPSOLVE_DATA_DIR: "", LOCALAPPDATA: WIN_LOCAL }, "C:\\Users\\eric")).toBe(
      "C:\\Users\\eric\\AppData\\Local\\snapsolve",
    );
  });

  it("a relative SNAPSOLVE_DATA_DIR is rejected, not resolved against the cwd", () => {
    const e = thrown(() => resolveDataDir("win32", { SNAPSOLVE_DATA_DIR: "data", LOCALAPPDATA: WIN_LOCAL }, "C:\\Users\\eric"));
    expect(e).toBeInstanceOf(SnapsolveError);
    expect(e).toMatchObject({ kind: "dataDirUnavailable" });
  });

  it("win32: %LOCALAPPDATA%\\snapsolve", () => {
    expect(resolveDataDir("win32", { LOCALAPPDATA: WIN_LOCAL }, "C:\\Users\\eric")).toBe(
      "C:\\Users\\eric\\AppData\\Local\\snapsolve",
    );
  });

  it("darwin: ~/Library/Application Support/snapsolve", () => {
    expect(resolveDataDir("darwin", {}, "/Users/eric")).toBe("/Users/eric/Library/Application Support/snapsolve");
  });

  it.each([{}, { LOCALAPPDATA: "" }, { LOCALAPPDATA: "AppData\\Local" }])(
    "win32 without a usable LOCALAPPDATA (%j) → dataDirUnavailable",
    (env) => {
      const e = thrown(() => resolveDataDir("win32", env, "C:\\Users\\eric"));
      expect(e).toBeInstanceOf(SnapsolveError);
      expect(e).toMatchObject({ kind: "dataDirUnavailable" });
    },
  );

  it.each(["", "Users/eric"])("darwin without a usable home dir (%j) → dataDirUnavailable", (home) => {
    const e = thrown(() => resolveDataDir("darwin", {}, home));
    expect(e).toBeInstanceOf(SnapsolveError);
    expect(e).toMatchObject({ kind: "dataDirUnavailable" });
  });

  it.each(["linux", "freebsd", "aix"] as const)("unsupported platform %s → unsupportedPlatform", (platform) => {
    const e = thrown(() => resolveDataDir(platform, { LOCALAPPDATA: WIN_LOCAL }, "/home/eric"));
    expect(e).toBeInstanceOf(SnapsolveError);
    expect(e).toMatchObject({ kind: "unsupportedPlatform" });
  });
});

describe("dataPaths", () => {
  it("maps the data dir to the SPEC §5.1 layout", () => {
    const d = path.join(os.tmpdir(), "snapsolve-layout");
    expect(dataPaths(d)).toEqual({
      dir: d,
      config: path.join(d, "config.json"),
      threads: path.join(d, "threads"),
      sessions: path.join(d, "sessions"),
      logs: path.join(d, "logs"),
      logFile: path.join(d, "logs", "snapsolve.log"),
      app: path.join(d, "app"),
      windowState: path.join(d, "window.json"),
    });
  });
});

describe("ensureDirs", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "snapsolve-paths-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates the data dir and threads/, sessions/, logs/", async () => {
    const p = dataPaths(path.join(tmp, "nested", "snapsolve"));
    await ensureDirs(p);
    for (const d of [p.dir, p.threads, p.sessions, p.logs]) {
      expect((await stat(d)).isDirectory(), d).toBe(true);
    }
  });

  it("is idempotent and leaves existing contents alone", async () => {
    const p = dataPaths(path.join(tmp, "snapsolve"));
    await ensureDirs(p);
    const kept = path.join(p.threads, "keep.txt");
    await writeFile(kept, "x");
    await ensureDirs(p);
    await ensureDirs(p);
    expect(await readdir(p.threads)).toEqual(["keep.txt"]);
  });

  it("a file in the way → dataDirUnavailable with the cause attached", async () => {
    const blocker = path.join(tmp, "snapsolve");
    await writeFile(blocker, "not a directory");
    const err = await ensureDirs(dataPaths(blocker)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SnapsolveError);
    expect(err).toMatchObject({ kind: "dataDirUnavailable" });
    expect((err as SnapsolveError).cause).toBeDefined();
  });
});
