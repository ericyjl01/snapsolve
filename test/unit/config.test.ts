import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, loadConfig } from "../../src/main/config";

const SPEC_DEFAULTS = {
  hotkeys: { capture: "Control+Alt+C", append: "Control+Alt+Shift+Q", toggle: "Control+Alt+X" },
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

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "snapsolve-config-"));
  file = path.join(dir, "config.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: unknown): Promise<void> {
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/** Bytes and mtime, to prove loadConfig never rewrites an existing file. */
async function snapshot(): Promise<{ bytes: string; mtimeMs: number }> {
  return { bytes: (await readFile(file)).toString("base64"), mtimeMs: (await stat(file)).mtimeMs };
}

describe("DEFAULTS", () => {
  it("match SPEC §6.1", () => {
    expect(DEFAULTS).toEqual(SPEC_DEFAULTS);
  });

  it("default capture hotkey is Control+Alt+C (064)", () => {
    expect(DEFAULTS.hotkeys.capture).toBe("Control+Alt+C");
    expect(DEFAULTS.hotkeys.append).toBe("Control+Alt+Shift+Q");
  });

  it("autoHideSec is 0 and allowApiKey is false", () => {
    expect(DEFAULTS.autoHideSec).toBe(0);
    expect(DEFAULTS.allowApiKey).toBe(false);
  });
});

describe("loadConfig", () => {
  it("a user's existing capture value is kept (the old default Control+Alt+Q is not migrated)", async () => {
    await writeConfig({ hotkeys: { capture: "Control+Alt+Q" } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config.hotkeys).toEqual({ capture: "Control+Alt+Q", append: "Control+Alt+Shift+Q" });
    expect(await snapshot()).toEqual(before);
  });

  it("missing file → written with defaults and returned", async () => {
    const r = await loadConfig(file);
    expect(r).toEqual({ config: SPEC_DEFAULTS, warnings: [], created: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(SPEC_DEFAULTS);
  });

  it("creating the file leaves no temp file behind", async () => {
    await loadConfig(file);
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  it("a file created by the first run is read, not rewritten, by the next", async () => {
    await loadConfig(file);
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r).toEqual({ config: SPEC_DEFAULTS, warnings: [], created: false });
    expect(await snapshot()).toEqual(before);
  });

  it("creation failure → defaults + warning, no stray files", async () => {
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "a file where the data dir should be");
    const r = await loadConfig(path.join(blocker, "config.json"));
    expect(r.config).toEqual(SPEC_DEFAULTS);
    expect(r.created).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(await readdir(dir)).toEqual(["blocker"]);
  });

  it("missing parent directory is created", async () => {
    const nested = path.join(dir, "a", "b", "config.json");
    const r = await loadConfig(nested);
    expect(r.created).toBe(true);
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual(SPEC_DEFAULTS);
  });

  it("returns a copy: mutating it leaves DEFAULTS intact", async () => {
    const r = await loadConfig(file);
    r.config.hotkeys.capture = "F9";
    r.config.model = "haiku";
    expect(DEFAULTS).toEqual(SPEC_DEFAULTS);
  });

  it("a valid file is honored and left untouched", async () => {
    const custom = {
      hotkeys: { capture: "CommandOrControl+Shift+Space", append: "Ctrl+Alt+num5", toggle: "Alt+F8" },
      model: "claude-opus-5-5[1m]",
      effort: "max",
      panelWidth: 500,
      autoHideSec: 30,
      claudePath: path.join(dir, "bin", "claude.exe"),
      allowApiKey: true,
      maxConcurrent: 3,
      maxScreenshotsPerThread: 4,
      timeoutSec: 300,
    };
    await writeConfig(custom);
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r).toEqual({ config: custom, warnings: [], created: false });
    expect(await snapshot()).toEqual(before);
  });

  it("a partial file takes defaults for missing fields, without warnings", async () => {
    await writeConfig({ model: "sonnet", hotkeys: { append: "Control+Alt+Shift+W" } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({
      ...SPEC_DEFAULTS,
      model: "sonnet",
      hotkeys: { capture: "Control+Alt+C", append: "Control+Alt+Shift+W", toggle: "Control+Alt+X" },
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["model", 5],
    ["model", ""],
    ["model", "opus --tools Bash"],
    ["effort", "extreme"],
    ["panelWidth", "wide"],
    ["panelWidth", 10],
    ["autoHideSec", -5],
    ["claudePath", "claude"],
    ["claudePath", 7],
    ["allowApiKey", "yes"],
    ["maxConcurrent", 0],
    ["maxConcurrent", 1.5],
    ["maxScreenshotsPerThread", 0],
    ["timeoutSec", -1],
    ["timeoutSec", "180"],
    ["hotkeys", "Control+Alt+Q"],
  ])("%s = %j → default, one warning naming it, file untouched", async (key, value) => {
    await writeConfig({ [key]: value });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config).toEqual(SPEC_DEFAULTS);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(key);
    expect(await snapshot()).toEqual(before);
  });

  it("several bad fields → one warning each; the valid ones are kept", async () => {
    await writeConfig({
      model: 5,
      maxConcurrent: 0,
      timeoutSec: -1,
      hotkeys: { capture: "Control+Alt+Nope", append: "Control+Alt+Shift+W" },
      panelWidth: 500,
    });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toHaveLength(4);
    expect(r.config).toEqual({
      ...SPEC_DEFAULTS,
      panelWidth: 500,
      hotkeys: { capture: "Control+Alt+C", append: "Control+Alt+Shift+W", toggle: "Control+Alt+X" },
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "",
    "Control+Alt",
    "Q",
    "Shift+Q",
    "Control+Alt+Q+W",
    "Control+Control+Q",
    "Ctrl+Control+Q",
    "Control+Alt+Nope",
    "Control++Q",
    "Control+Alt+",
    " Control+Alt+Q",
    42,
  ])("bad accelerator %j → hotkeys.capture default + one warning, file untouched", async (capture) => {
    await writeConfig({ hotkeys: { capture } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config.hotkeys).toEqual(SPEC_DEFAULTS.hotkeys);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("hotkeys.capture");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["control+alt+w", "CmdOrCtrl+Shift+Space", "F9", "Super+Plus", "Alt+F7", "AltGr+F1", "Option+Shift+PageUp"])(
    "good accelerator %j is honored",
    async (capture) => {
      await writeConfig({ hotkeys: { capture } });
      const r = await loadConfig(file);
      expect(r.warnings).toEqual([]);
      expect(r.config.hotkeys.capture).toBe(capture);
    },
  );

  it("identical capture and append (case and aliases ignored) → both defaults + one warning", async () => {
    await writeConfig({ hotkeys: { capture: "Control+Alt+W", append: "alt+ctrl+w" } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config.hotkeys).toEqual(SPEC_DEFAULTS.hotkeys);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("hotkeys");
    expect(await snapshot()).toEqual(before);
  });

  it("hotkeys.toggle default is Control+Alt+X; a good value is honored (060)", async () => {
    expect(DEFAULTS.hotkeys.toggle).toBe("Control+Alt+X");
    await writeConfig({ hotkeys: { toggle: "Control+Alt+T" } });
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config.hotkeys).toEqual({ ...SPEC_DEFAULTS.hotkeys, toggle: "Control+Alt+T" });
  });

  it.each(["", "X", "Control+Alt+Nope", 7])("bad hotkeys.toggle %j → its default + one warning naming hotkeys.toggle", async (toggle) => {
    await writeConfig({ hotkeys: { toggle } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config.hotkeys).toEqual(SPEC_DEFAULTS.hotkeys);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("hotkeys.toggle");
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    [{ capture: "Control+Alt+W", toggle: "alt+ctrl+w" }, "hotkeys.capture", "hotkeys.toggle"],
    [{ append: "Control+Alt+W", toggle: "Ctrl+Option+W" }, "hotkeys.append", "hotkeys.toggle"],
  ])("toggle the same key as another hotkey %j → defaults for all + one warning naming both", async (hotkeys, a, b) => {
    await writeConfig({ hotkeys });
    const r = await loadConfig(file);
    expect(r.config.hotkeys).toEqual(SPEC_DEFAULTS.hotkeys);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(a);
    expect(r.warnings[0]).toContain(b);
  });

  it("malformed JSON → defaults + warning, file untouched", async () => {
    await writeConfig('{ "model": opus, ');
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config).toEqual(SPEC_DEFAULTS);
    expect(r.created).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["[]", "null", "42", '"opus"', ""])("non-object JSON %j → defaults + warning, file untouched", async (text) => {
    await writeConfig(text);
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config).toEqual(SPEC_DEFAULTS);
    expect(r.warnings).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  });

  it("unknown keys → one warning each and ignored; known fields kept", async () => {
    await writeConfig({
      model: "sonnet",
      colour: "blue",
      hotkeys: { capture: "Control+Alt+C", append: "Control+Alt+Shift+Q", extra: "x" },
    });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config).toEqual({ ...SPEC_DEFAULTS, model: "sonnet" });
    expect(r.config).not.toHaveProperty("colour");
    expect(r.config.hotkeys).not.toHaveProperty("extra");
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join("\n")).toContain("colour");
    expect(r.warnings.join("\n")).toContain("hotkeys.extra");
    expect(await snapshot()).toEqual(before);
  });

  it("a UTF-8 BOM (Windows Notepad) is accepted", async () => {
    await writeConfig("﻿" + JSON.stringify({ model: "sonnet" }));
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config.model).toBe("sonnet");
  });

  it("an unreadable config path → defaults + warning, nothing created or replaced", async () => {
    await mkdir(file);
    const r = await loadConfig(file);
    expect(r.config).toEqual(SPEC_DEFAULTS);
    expect(r.created).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect((await stat(file)).isDirectory()).toBe(true);
  });

  it("logs each warning when given a logger", async () => {
    await writeConfig({ model: 5, colour: "blue" });
    const warn = vi.fn();
    const r = await loadConfig(file, { log: { warn } });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["config.warning", "config.warning"]);
    expect(warn.mock.calls.map((c) => c[1].message)).toEqual(r.warnings);
  });
});
