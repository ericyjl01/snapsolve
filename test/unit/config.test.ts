import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, loadConfig, saveTheme, saveTransparency } from "../../src/main/config";

const SPEC_DEFAULTS = {
  // No append key (065): a capture continues the current thread. Voice (063): dictate a follow-up.
  hotkeys: { capture: "Control+Alt+C", toggle: "Control+Alt+X", voice: "Control+Alt+V" },
  model: "opus",
  effort: "high",
  panelWidth: 420,
  autoHideSec: 0,
  claudePath: null,
  allowApiKey: false,
  maxConcurrent: 2,
  maxScreenshotsPerThread: 6,
  timeoutSec: 180,
  // 075: snapsolve is dark unless config.json says otherwise.
  theme: "dark",
  // 090 (Amendments 23, 24): how see-through the window's ground is, in percent.
  transparency: 20,
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
    expect(DEFAULTS.hotkeys).not.toHaveProperty("append");
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
    expect(r.config.hotkeys).toEqual({ capture: "Control+Alt+Q", toggle: "Control+Alt+X", voice: "Control+Alt+V" });
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
      hotkeys: { capture: "CommandOrControl+Shift+Space", toggle: "Alt+F8", voice: "Alt+F9" },
      model: "claude-opus-5-5[1m]",
      effort: "max",
      panelWidth: 500,
      autoHideSec: 30,
      claudePath: path.join(dir, "bin", "claude.exe"),
      allowApiKey: true,
      maxConcurrent: 3,
      maxScreenshotsPerThread: 4,
      timeoutSec: 300,
      theme: "light",
    };
    await writeConfig(custom);
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r).toEqual({ config: custom, warnings: [], created: false });
    expect(await snapshot()).toEqual(before);
  });

  it("a partial file takes defaults for missing fields, without warnings", async () => {
    await writeConfig({ model: "sonnet", hotkeys: { toggle: "Control+Alt+T" } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({
      ...SPEC_DEFAULTS,
      model: "sonnet",
      hotkeys: { capture: "Control+Alt+C", toggle: "Control+Alt+T", voice: "Control+Alt+V" },
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
    ["theme", "blue"],
    ["theme", 1],
    ["theme", null],
    ["theme", "Dark"],
    ["transparency", -10],
    ["transparency", 15],
    ["transparency", 100],
    ["transparency", 12.5],
    ["transparency", "20"],
    ["transparency", null],
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
      hotkeys: { capture: "Control+Alt+Nope", toggle: "Control+Alt+T" },
      panelWidth: 500,
    });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toHaveLength(4);
    expect(r.config).toEqual({
      ...SPEC_DEFAULTS,
      panelWidth: 500,
      hotkeys: { capture: "Control+Alt+C", toggle: "Control+Alt+T", voice: "Control+Alt+V" },
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

  // 065: the append hotkey is gone; a user's old config keeps working.
  // The same key as capture is no clash: append is never registered.
  it.each(["Control+Alt+Shift+Q", "Control+Alt+W", "not a key"])(
    "hotkeys.append %j (065) is ignored with one warning that it is no longer used; the other keys are kept, file untouched",
    async (append) => {
      await writeConfig({ hotkeys: { capture: "Control+Alt+W", append } });
      const before = await snapshot();
      const r = await loadConfig(file);
      expect(r.config.hotkeys).toEqual({ capture: "Control+Alt+W", toggle: "Control+Alt+X", voice: "Control+Alt+V" });
      expect(r.config.hotkeys).not.toHaveProperty("append");
      expect(r.warnings).toEqual([expect.stringMatching(/hotkeys\.append.*no longer used/)]);
      expect(await snapshot()).toEqual(before);
    },
  );

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

  it("voice hotkey default and validation: hotkeys.voice defaults to Control+Alt+V; a good value is honored (063)", async () => {
    expect(DEFAULTS.hotkeys.voice).toBe("Control+Alt+V");
    await writeConfig({ hotkeys: { voice: "Control+Shift+Space" } });
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config.hotkeys).toEqual({ ...SPEC_DEFAULTS.hotkeys, voice: "Control+Shift+Space" });
  });

  it.each(["", "V", "Shift+V", "Control+Alt+Nope", null])("bad hotkeys.voice %j → its default + one warning naming hotkeys.voice (063)", async (voice) => {
    await writeConfig({ hotkeys: { voice } });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.config.hotkeys).toEqual(SPEC_DEFAULTS.hotkeys);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("hotkeys.voice");
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    [{ capture: "Control+Alt+W", toggle: "alt+ctrl+w" }, "hotkeys.capture", "hotkeys.toggle"],
    [{ capture: "Control+Alt+V" }, "hotkeys.capture", "hotkeys.voice"],
    [{ toggle: "Control+Alt+W", voice: "Alt+Control+W" }, "hotkeys.toggle", "hotkeys.voice"],
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
      hotkeys: { capture: "Control+Alt+C", toggle: "Control+Alt+X", extra: "x" },
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

describe("theme (075)", () => {
  it("defaults to dark", () => {
    expect(DEFAULTS.theme).toBe("dark");
  });

  it.each(["dark", "light", "system"])("%s is accepted without a warning", async (theme) => {
    await writeConfig({ theme });
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({ ...SPEC_DEFAULTS, theme });
  });

  it("an invalid value falls back to dark with one warning naming the allowed values", async () => {
    await writeConfig({ theme: "blue" });
    const r = await loadConfig(file);
    expect(r.config.theme).toBe("dark");
    expect(r.warnings).toHaveLength(1);
    for (const word of ["theme", "dark", "light", "system"]) expect(r.warnings[0]).toContain(word);
  });

  it("an existing file without theme gets dark, no warning, and is not rewritten", async () => {
    await writeConfig({ model: "opus", effort: "medium" });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config.theme).toBe("dark");
    expect(await snapshot()).toEqual(before);
  });
});

// 090 (Amendments 23, 24): 0, 10, … 90 percent see-through; 100 is not offered (the ground would vanish).
describe("transparency (090)", () => {
  it("defaults to 20", () => {
    expect(DEFAULTS.transparency).toBe(20);
  });

  it.each([0, 10, 50, 90])("%i is accepted without a warning", async (transparency) => {
    await writeConfig({ transparency });
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({ ...SPEC_DEFAULTS, transparency });
  });

  it("an invalid value falls back to 20 with one warning saying what is allowed", async () => {
    await writeConfig({ transparency: 15 });
    const r = await loadConfig(file);
    expect(r.config.transparency).toBe(20);
    expect(r.warnings).toHaveLength(1);
    for (const word of ["transparency", "0", "90", "10"]) expect(r.warnings[0]).toContain(word);
  });

  it("an existing file without transparency gets 20, no warning, and is not rewritten", async () => {
    await writeConfig({ model: "opus", theme: "light" });
    const before = await snapshot();
    const r = await loadConfig(file);
    expect(r.warnings).toEqual([]);
    expect(r.config.transparency).toBe(20);
    expect(await snapshot()).toEqual(before);
  });
});

// 090: the tray's Transparency choice is saved like Appearance (077): only that key changes.
describe("saveTransparency (090)", () => {
  it("rewrites only transparency: other keys and values (unknown keys too) stay as they are", async () => {
    const original = { model: "sonnet", theme: "light", transparency: 20, myNote: "keep me" };
    await writeConfig(original);
    expect(await saveTransparency(file, 50)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...original, transparency: 50 });
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual(Object.keys(original));
  });

  it("adds transparency to a config.json that has none; a missing file gets the defaults plus it", async () => {
    await writeConfig({ model: "opus" });
    expect(await saveTransparency(file, 0)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ model: "opus", transparency: 0 });
    await rm(file);
    expect(await saveTransparency(file, 90)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...SPEC_DEFAULTS, transparency: 90 });
  });

  it("malformed JSON is left untouched and an error is returned (no throw); no temp file is left", async () => {
    await writeConfig("{ not json");
    const before = await snapshot();
    const result = await saveTransparency(file, 40);
    expect(result.ok).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  it("the saved value is what loadConfig then reads, and saving the theme afterwards keeps it", async () => {
    await writeConfig({ theme: "dark" });
    await saveTransparency(file, 70);
    await saveTheme(file, "light");
    expect((await loadConfig(file)).config).toMatchObject({ theme: "light", transparency: 70 });
  });
});

// 077 (Amendment 14): the tray's Appearance choice is saved into config.json, every other key left as it was.
describe("saveTheme (077)", () => {
  it("rewrites only theme: other keys and values (unknown keys too) stay as they are", async () => {
    const original = { model: "sonnet", hotkeys: { capture: "Control+Alt+Q" }, timeoutSec: 99, myNote: "keep me", theme: "dark" };
    await writeConfig(original);
    const result = await saveTheme(file, "light");
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...original, theme: "light" });
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual(Object.keys(original));
  });

  it("adds theme to a config.json that has none", async () => {
    await writeConfig({ model: "opus" });
    expect(await saveTheme(file, "system")).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ model: "opus", theme: "system" });
  });

  it("writes atomically: no temp file is left behind, and a failed swap leaves the old file intact", async () => {
    await writeConfig({ model: "opus", theme: "dark" });
    const before = await readFile(file, "utf8");
    const result = await saveTheme(file, "light", {
      rename: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    });
    expect(result.ok).toBe(false);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["config.json"]);
    expect(await saveTheme(file, "light")).toEqual({ ok: true });
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  it("a missing config.json is written with the defaults and the new theme", async () => {
    expect(await saveTheme(file, "light")).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...SPEC_DEFAULTS, theme: "light" });
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["a JSON array", "[1, 2]"],
  ])("%s: the file is left untouched and an error is returned (no throw)", async (_name, content) => {
    await writeConfig(content);
    const before = await snapshot();
    const result = await saveTheme(file, "light");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/config\.json/);
    expect(await snapshot()).toEqual(before);
    expect(await readdir(dir)).toEqual(["config.json"]);
  });

  it("the saved theme is what loadConfig then reads", async () => {
    await writeConfig({ theme: "dark" });
    await saveTheme(file, "light");
    expect((await loadConfig(file)).config.theme).toBe("light");
  });
});
