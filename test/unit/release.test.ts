import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assemble, parseArgs, renameRetrying } from "../../scripts/release.mjs";
import { repoRoot } from "../paths";

const VERSION = "0.2.0";
const DESCRIPTION = "Press a hotkey, capture the screen, get a step-by-step solution from Claude in a side panel.";

const MARKETPLACE = `{
  "name": "claude-skills",
  "owner": { "name": "someone" },
  "plugins": [
    { "name": "council",  "source": "./plugins/council",  "description": "Deliberation council." },
    { "name": "vid",      "source": "./plugins/vid",      "description": "Video understanding." }
  ]
}
`;

const README = `# claude-skills

## Plugins

| Plugin | What it does | How to trigger | Setup needed |
|---|---|---|---|
| \`council\` | Deliberation council | \`/council <question>\` | none |
| \`vid\` | Video understanding | say "analyze this video" | ffmpeg |

Setup details live elsewhere.
`;

const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 13, 10, 255, 0]);
const WOFF2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 13, 10, 0, 1, 2]);

let tmp: string;
let root: string;
let target: string;

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function pkg(version = VERSION) {
  return {
    name: "snapsolve",
    version,
    private: true,
    description: DESCRIPTION,
    main: "dist/main.js",
    scripts: { build: "node scripts/build.mjs", start: "electron dist/main.js" },
    dependencies: { "@electron/packager": "20.3.0", "markdown-it": "^15.0.2" },
    devDependencies: { electron: "44.7.2", vitest: "^5.0.4" },
  };
}

function lock(version = VERSION) {
  const p = pkg(version);
  return `${JSON.stringify(
    {
      name: "snapsolve",
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "snapsolve", version, dependencies: p.dependencies, devDependencies: p.devDependencies } },
    },
    null,
    2,
  )}\n`;
}

/** A fake repo root with a built dist/ and everything release.mjs reads, plus files it must leave out. */
function makeRoot(dir: string, version = VERSION): void {
  write(path.join(dir, "package.json"), `${JSON.stringify(pkg(version), null, 2)}\n`);
  write(path.join(dir, "package-lock.json"), lock(version));
  write(path.join(dir, "dist", "main.js"), `"use strict";\n// main ${version}\n`);
  write(path.join(dir, "dist", "main.js.map"), "{}");
  write(path.join(dir, "dist", "preload.js"), "// preload\n");
  write(path.join(dir, "dist", "preload.js.map"), "{}");
  write(path.join(dir, "dist", "renderer", "index.html"), "<!doctype html>\n");
  write(path.join(dir, "dist", "renderer", "renderer.js"), "// renderer\n");
  write(path.join(dir, "dist", "renderer", "renderer.js.map"), "{}");
  write(path.join(dir, "dist", "renderer", "styles.css"), "body{}\n");
  write(path.join(dir, "dist", "renderer", "katex.min.css"), ".katex{}\n");
  write(path.join(dir, "dist", "renderer", "fonts", "KaTeX_Main-Regular.woff2"), WOFF2);
  write(path.join(dir, "prompts", "system.md"), "You explain problems.\r\nStep by step.\r\n");
  write(path.join(dir, "assets", "icon.ico"), ICO);
  write(path.join(dir, "bootstrap", "boot.js"), "// boot\n");
  write(path.join(dir, "bootstrap", "package.json"), '{ "name": "snapsolve", "main": "boot.js" }\n');
  write(
    path.join(dir, "plugin", ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "snapsolve", description: "snapsolve plugin", author: { name: "someone" } }, null, 2)}\n`,
  );
  write(path.join(dir, "plugin", "skills", "snapsolve", "SKILL.md"), "---\nname: snapsolve\n---\n");
  write(path.join(dir, "plugin", "skills", "snapsolve", "scripts", "snapsolve.mjs"), "// cli\n");
  write(path.join(dir, "plugin", "skills", "snapsolve", ".DS_Store"), "junk");
  write(path.join(dir, "src", "main", "main.ts"), "// source\n");
  write(path.join(dir, "test", "unit", "x.test.ts"), "// test\n");
  write(path.join(dir, "node_modules", "markdown-it", "index.js"), "// dep\n");
  // node_modules inside directories assemble walks, so the exact-list test proves they are left out.
  write(path.join(dir, "bootstrap", "node_modules", "x", "index.js"), "// dep\n");
  write(path.join(dir, "plugin", "skills", "snapsolve", "scripts", "node_modules", "x", "index.js"), "// dep\n");
}

function makeTarget(dir: string): void {
  write(path.join(dir, ".claude-plugin", "marketplace.json"), MARKETPLACE);
  write(path.join(dir, "README.md"), README);
  write(path.join(dir, "plugins", "council", ".claude-plugin", "plugin.json"), '{ "name": "council" }\n');
}

/** Every file under `dir` as a sorted list of posix-style relative paths. */
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

/** Every file under `dir` with its bytes, to compare whole trees. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(files(dir).map((f) => [f, readFileSync(path.join(dir, f)).toString("base64")]));
}

const pluginDir = () => path.join(target, "plugins", "snapsolve");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const EXPECTED = [
  ".claude-plugin/plugin.json",
  "app/assets/icon.ico",
  "app/bootstrap/boot.js",
  "app/bootstrap/package.json",
  "app/main.js",
  "app/package-lock.json",
  "app/package.json",
  "app/preload.js",
  "app/prompts/system.md",
  "app/renderer/fonts/KaTeX_Main-Regular.woff2",
  "app/renderer/index.html",
  "app/renderer/katex.min.css",
  "app/renderer/renderer.js",
  "app/renderer/styles.css",
  "skills/snapsolve/SKILL.md",
  "skills/snapsolve/scripts/snapsolve.mjs",
];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "snapsolve-release-"));
  root = path.join(tmp, "repo");
  target = path.join(tmp, "claude-skills");
  makeRoot(root);
  makeTarget(target);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("assemble: the plugin tree", () => {
  it("writes exactly the manifest, skill, scripts and app payload — no maps, sources, tests, deps or junk dotfiles", () => {
    assemble({ root, target });
    expect(files(pluginDir())).toEqual(EXPECTED);
  });

  it("copies binaries byte for byte and the built JS unchanged", () => {
    assemble({ root, target });
    expect(readFileSync(path.join(pluginDir(), "app", "assets", "icon.ico")).equals(ICO)).toBe(true);
    expect(readFileSync(path.join(pluginDir(), "app", "renderer", "fonts", "KaTeX_Main-Regular.woff2")).equals(WOFF2)).toBe(true);
    expect(readFileSync(path.join(pluginDir(), "app", "main.js"))).toEqual(readFileSync(path.join(root, "dist", "main.js")));
    expect(readFileSync(path.join(pluginDir(), "app", "bootstrap", "boot.js"))).toEqual(readFileSync(path.join(root, "bootstrap", "boot.js")));
  });

  it("no assets/ in the repo → no app/assets in the payload", async () => {
    await rm(path.join(root, "assets"), { recursive: true });
    assemble({ root, target });
    expect(files(pluginDir())).toEqual(EXPECTED.filter((f) => !f.startsWith("app/assets/")));
  });

  it("text files come out with LF line endings only (a CRLF source is normalized)", () => {
    assemble({ root, target });
    for (const f of files(pluginDir()).filter((name) => /\.(md|mjs|js|json|html|css)$/.test(name))) {
      expect(readFileSync(path.join(pluginDir(), f), "utf8"), f).not.toContain("\r\n");
    }
    expect(readFileSync(path.join(pluginDir(), "app", "prompts", "system.md"), "utf8")).toBe("You explain problems.\nStep by step.\n");
  });
});

describe("assemble: versions and the install manifest", () => {
  // DECISIONS 2026-10-14 (027): no `version`, per the claude-skills convention, so /plugin update always pulls the
  // latest; the app version lives in app/package.json.
  it("plugin.json keeps its fields and has no version", () => {
    assemble({ root, target });
    const manifest = readJson(path.join(pluginDir(), ".claude-plugin", "plugin.json"));
    expect(manifest).toEqual({
      name: "snapsolve",
      description: "snapsolve plugin",
      author: { name: "someone" },
    });
    expect(manifest).not.toHaveProperty("version");
  });

  it("a version in the source plugin.json is not released either", () => {
    write(
      path.join(root, "plugin", ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "snapsolve", description: "snapsolve plugin", version: "9.9.9" }, null, 2)}\n`,
    );
    assemble({ root, target });
    expect(readJson(path.join(pluginDir(), ".claude-plugin", "plugin.json"))).toEqual({
      name: "snapsolve",
      description: "snapsolve plugin",
    });
  });

  it("app/package.json: main.js, same version, no scripts, @electron/packager pinned exactly in dependencies", () => {
    assemble({ root, target });
    const app = readJson(path.join(pluginDir(), "app", "package.json"));
    expect(app.main).toBe("main.js");
    expect(app.version).toBe(VERSION);
    expect(app.scripts).toBeUndefined();
    expect(app.dependencies["@electron/packager"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(app.devDependencies).toEqual(pkg().devDependencies);
  });

  it("app/package-lock.json is the root lockfile byte for byte, and its root entry matches app/package.json", () => {
    assemble({ root, target });
    const appLock = readFileSync(path.join(pluginDir(), "app", "package-lock.json"));
    expect(appLock.equals(readFileSync(path.join(root, "package-lock.json")))).toBe(true);
    const app = readJson(path.join(pluginDir(), "app", "package.json"));
    const rootEntry = JSON.parse(appLock.toString("utf8")).packages[""];
    expect(rootEntry.dependencies).toEqual(app.dependencies);
    expect(rootEntry.devDependencies).toEqual(app.devDependencies);
    expect(rootEntry.version).toBe(app.version);
  });
});

describe("assemble: marketplace entry and README row", () => {
  it("adds one snapsolve entry and leaves the other entries' text and order untouched", () => {
    assemble({ root, target });
    const text = readFileSync(path.join(target, ".claude-plugin", "marketplace.json"), "utf8");
    for (const line of MARKETPLACE.split("\n").filter((l) => l.includes('"name": "council"') || l.includes('"name": "vid"'))) {
      expect(text).toContain(line.trimEnd().replace(/,$/, ""));
    }
    const market = JSON.parse(text);
    expect(market.name).toBe("claude-skills");
    expect(market.plugins.map((p: { name: string }) => p.name)).toEqual(["council", "vid", "snapsolve"]);
    expect(market.plugins[2]).toEqual({ name: "snapsolve", source: "./plugins/snapsolve", description: DESCRIPTION });
  });

  it("adds one README row at the end of the plugin table", () => {
    assemble({ root, target });
    const lines = readFileSync(path.join(target, "README.md"), "utf8").split("\n");
    const rows = lines.filter((l) => l.startsWith("| `snapsolve`"));
    expect(rows).toHaveLength(1);
    expect(lines.indexOf(rows[0])).toBe(lines.findIndex((l) => l.startsWith("| `vid`")) + 1);
    expect(rows[0]).toContain("/snapsolve install");
    expect(rows[0]).toContain("Node ≥ 22.12");
    expect(rows[0].split("|").length).toBe(lines.find((l) => l.startsWith("| Plugin"))?.split("|").length);
  });

  it("a second run adds no second entry or row and changes nothing", () => {
    assemble({ root, target });
    const before = snapshot(target);
    const result = assemble({ root, target });
    expect(snapshot(target)).toEqual(before);
    expect(result.changed).toBe(false);
  });

  it("a README without a plugin table is left alone, with a warning", () => {
    write(path.join(target, "README.md"), "# claude-skills\n\nNo table here.\n");
    const result = assemble({ root, target });
    expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# claude-skills\n\nNo table here.\n");
    expect(result.warnings.join("\n")).toMatch(/README/);
    expect(files(pluginDir())).toEqual(EXPECTED);
  });
});

describe("assemble: re-releases", () => {
  it("a new version replaces the plugin dir: files the old release had and this one lacks are gone", () => {
    assemble({ root, target });
    write(path.join(pluginDir(), "app", "stale.js"), "// from an older release\n");
    makeRoot(root, "0.3.0");
    assemble({ root, target });
    expect(existsSync(path.join(pluginDir(), "app", "stale.js"))).toBe(false);
    expect(files(pluginDir())).toEqual(EXPECTED);
    expect(readJson(path.join(pluginDir(), "app", "package.json")).version).toBe("0.3.0");
  });

  it("same version with a different app/ → refuses (bump the version) and writes nothing", () => {
    assemble({ root, target });
    const before = snapshot(target);
    write(path.join(root, "dist", "main.js"), "// changed code, same version\n");
    expect(() => assemble({ root, target })).toThrow(/bump the version/);
    expect(snapshot(target)).toEqual(before);
  });

  it("same version with only the skill changed → written (the app version gates app/ only)", () => {
    assemble({ root, target });
    write(path.join(root, "plugin", "skills", "snapsolve", "SKILL.md"), "---\nname: snapsolve\n---\nNew text.\n");
    const result = assemble({ root, target });
    expect(result.changed).toBe(true);
    expect(readFileSync(path.join(pluginDir(), "skills", "snapsolve", "SKILL.md"), "utf8")).toContain("New text.");
  });
});

describe("assemble: a failed swap", () => {
  const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

  it("keeps the previous release byte for byte and leaves marketplace.json and README untouched", () => {
    assemble({ root, target });
    const before = snapshot(target);
    makeRoot(root, "0.3.0");
    const rename = (from: string, to: string) => {
      if (from.includes("-staging-")) throw eperm();
      renameSync(from, to);
    };
    expect(() => assemble({ root, target, rename })).toThrow(/EPERM/);
    expect(snapshot(target)).toEqual(before);
  });

  it("if even the restore fails, the error says where the previous release is, and it is still there", () => {
    assemble({ root, target });
    const released = snapshot(pluginDir());
    makeRoot(root, "0.3.0");
    const rename = (from: string, to: string) => {
      if (from.includes("-staging-") || from.includes("-old-")) throw eperm();
      renameSync(from, to);
    };
    let message = "";
    try {
      assemble({ root, target, rename });
    } catch (e) {
      message = (e as Error).message;
    }
    const kept = /previous release is kept at (.+)$/.exec(message)?.[1];
    expect(kept, message).toBeTruthy();
    expect(snapshot(kept as string)).toEqual(released);
  });
});

describe("renameRetrying", () => {
  const failing = (code: string, times: number) => {
    let calls = 0;
    return vi.fn(() => {
      if (calls++ < times) throw Object.assign(new Error(code), { code });
    });
  };

  it.each(["EPERM", "EBUSY", "EACCES"])("retries a transient %s with growing waits, then succeeds", (code) => {
    const rename = failing(code, 2);
    const sleep = vi.fn();
    renameRetrying("a", "b", { rename, sleep });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([20, 50]);
  });

  it("any other code is thrown at once, without waiting", () => {
    const rename = failing("ENOENT", 1);
    const sleep = vi.fn();
    expect(() => renameRetrying("a", "b", { rename, sleep })).toThrow("ENOENT");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after a bounded number of tries (about 3.5 s of waiting)", () => {
    const rename = failing("EPERM", Number.POSITIVE_INFINITY);
    const sleep = vi.fn();
    expect(() => renameRetrying("a", "b", { rename, sleep })).toThrow("EPERM");
    const waits = sleep.mock.calls.map((c) => c[0] as number);
    expect(rename).toHaveBeenCalledTimes(waits.length + 1);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000);
  });
});

describe("assemble: refusals", () => {
  it("target without .claude-plugin/marketplace.json → error, nothing written", async () => {
    await rm(path.join(target, ".claude-plugin"), { recursive: true });
    const before = snapshot(target);
    expect(() => assemble({ root, target })).toThrow(/marketplace\.json/);
    expect(existsSync(pluginDir())).toBe(false);
    expect(snapshot(target)).toEqual(before);
  });

  it("dist/main.js missing → error naming npm run build, nothing written", async () => {
    await rm(path.join(root, "dist", "main.js"));
    const before = snapshot(target);
    expect(() => assemble({ root, target })).toThrow(/npm run build/);
    expect(snapshot(target)).toEqual(before);
  });
});

describe("parseArgs", () => {
  it("defaults to Eric's claude-skills marketplace in claude-setup-source", () => {
    expect(parseArgs([], "/home/x")).toEqual({
      target: path.join("/home/x", ".claude", "claude-setup-source", "plugins", "claude-skills"),
    });
  });

  it("--target <dir> resolves to an absolute path; anything else is an error", () => {
    expect(parseArgs(["--target", "some/dir"], "/home/x").target).toBe(path.resolve("some/dir"));
    expect(() => parseArgs(["--target"], "/home/x")).toThrow(/--target/);
    expect(() => parseArgs(["--force"], "/home/x")).toThrow(/--force/);
  });
});

describe("the repo's plugin sources and install dependency", () => {
  it("plugin/.claude-plugin/plugin.json names snapsolve and has no version", () => {
    const manifest = readJson(path.join(repoRoot, "plugin", ".claude-plugin", "plugin.json"));
    expect(manifest.name).toBe("snapsolve");
    expect(manifest.description).toBeTruthy();
    expect(manifest.version).toBeUndefined();
  });

  it("plugin/skills/snapsolve/SKILL.md exists with name: snapsolve in its frontmatter", () => {
    const skill = readFileSync(path.join(repoRoot, "plugin", "skills", "snapsolve", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\n[\s\S]*?^name: snapsolve$[\s\S]*?^---$/m);
  });

  it("@electron/packager is an exact runtime dependency, in step with the lockfile", () => {
    const rootPkg = readJson(path.join(repoRoot, "package.json"));
    const spec = rootPkg.dependencies?.["@electron/packager"];
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
    const rootLock = readJson(path.join(repoRoot, "package-lock.json"));
    expect(rootLock.packages[""].dependencies["@electron/packager"]).toBe(spec);
    expect(rootLock.packages["node_modules/@electron/packager"].version).toBe(spec);
  });
});
