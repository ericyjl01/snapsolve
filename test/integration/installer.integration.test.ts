// The real CLI end to end on Windows: `node snapsolve.mjs <command>` from a plugin laid out like a release, with
// LOCALAPPDATA/APPDATA/home in a temp dir, a fake `claude` (via the SNAPSOLVE_TEST hook, since only a claude.exe
// counts on Windows), a fake `npm` first on PATH whose `ci` installs a fake @electron/packager, a real PowerShell
// shortcut, and launches recorded instead of run.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../paths";

const SCRIPTS = path.join(repoRoot, "plugin", "skills", "snapsolve", "scripts");

const FAKE_CLAUDE = `const args = process.argv.slice(2).join(" ");
if (args === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args === "auth status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" }, null, 2));
  process.exit(0);
}
console.error("fake claude: unexpected arguments " + args);
process.exit(9);
`;

// \`npm ci\` stand-in: checks its arguments and installs a fake @electron/packager that writes a fake launcher.
const FAKE_NPM = `import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
if (args.join(" ") !== "ci --omit=dev --ignore-scripts") { console.error("fake npm: unexpected " + args.join(" ")); process.exit(1); }
const dir = path.join(process.cwd(), "node_modules", "@electron", "packager");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@electron/packager", version: "0.0.0-fake", type: "module", exports: { ".": "./index.js" } }));
writeFileSync(path.join(dir, "index.js"), [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'import path from "node:path";',
  "export async function packager(opts) {",
  '  const app = path.join(opts.out, "snapsolve-win32-x64");',
  "  mkdirSync(app, { recursive: true });",
  '  writeFileSync(path.join(app, "snapsolve.exe"), "fake launcher");',
  '  writeFileSync(path.join(app, "options.json"), JSON.stringify(opts));',
  "  return [app];",
  "}",
].join("\\n"));
console.log("added 1 package");
`;

let tmp: string;
let plugin: string;
let env: Record<string, string>;
let local: string;
let roaming: string;
let data: string;
const launches = () => (existsSync(path.join(tmp, "launch.log")) ? readFileSync(path.join(tmp, "launch.log"), "utf8").trim().split("\n") : []);

/** The real per-user locations an install would touch, to prove the test never writes there. */
const REAL = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "snapsolve"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "snapsolve"),
  process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "snapsolve.lnk"),
].filter((p): p is string => Boolean(p));
const realBefore = REAL.map((p) => existsSync(p));

function writePayload(version: string): void {
  const app = path.join(plugin, "app");
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "snapsolve", version, main: "main.js", devDependencies: { electron: "44.7.2" } }, null, 2)}\n`,
    "package-lock.json": "{}\n",
    "main.js": `// main ${version}\n`,
    "bootstrap/boot.js": "// boot\n",
    "bootstrap/package.json": '{ "name": "snapsolve", "main": "boot.js" }\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(app, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [path.join(plugin, "skills", "snapsolve", "scripts", "snapsolve.mjs"), ...args], {
    env,
    cwd: tmp,
    encoding: "utf8",
    timeout: 120_000,
  });
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  return { status: r.status, lines, stdout: r.stdout, stderr: r.stderr };
}

describe.runIf(process.platform === "win32")("installer CLI end to end (Windows)", () => {
  beforeAll(async () => {
    tmp = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "snapsolve-installer-")));
    plugin = path.join(tmp, "plugin");
    cpSync(SCRIPTS, path.join(plugin, "skills", "snapsolve", "scripts"), { recursive: true });
    writePayload("0.2.0");

    const bin = path.join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "claude.exe"), "stand-in: the SNAPSOLVE_TEST hook runs fake-claude.mjs for it");
    writeFileSync(path.join(bin, "fake-claude.mjs"), FAKE_CLAUDE);
    writeFileSync(path.join(bin, "fake-npm.mjs"), FAKE_NPM);
    writeFileSync(path.join(bin, "npm.cmd"), `@"${process.execPath}" "%~dp0fake-npm.mjs" %*\r\n`);

    local = path.join(tmp, "Local");
    roaming = path.join(tmp, "Roaming");
    data = path.join(local, "snapsolve");
    const home = path.join(tmp, "home");
    for (const dir of [local, roaming, home]) mkdirSync(dir, { recursive: true });

    env = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || /^path$/i.test(name) || /^(CLAUDECODE|CLAUDE_CODE_|SNAPSOLVE_)/i.test(name)) continue;
      env[name] = value;
    }
    Object.assign(env, {
      PATH: `${bin};${process.env.PATH ?? process.env.Path ?? ""}`,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      USERPROFILE: home,
      HOME: home,
      SNAPSOLVE_TEST: "1",
      SNAPSOLVE_TEST_CLAUDE: path.join(bin, "fake-claude.mjs"),
      SNAPSOLVE_TEST_LAUNCH_LOG: path.join(tmp, "launch.log"),
      FAKE_NPM_LOG: path.join(tmp, "npm.log"),
    });
  });

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("install → launcher, shortcut, current/main.js, config with claudePath and install.json; launched once", () => {
    const r = cli("install");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.lines.every((l) => l.startsWith("ok:")), r.stdout).toBe(true);

    const exe = path.join(local, "Programs", "snapsolve", "snapsolve.exe");
    expect(readFileSync(exe, "utf8")).toBe("fake launcher");
    const options = JSON.parse(readFileSync(path.join(local, "Programs", "snapsolve", "options.json"), "utf8"));
    expect(options).toMatchObject({ dir: path.join(data, "app", "0.2.0", "bootstrap"), electronVersion: "44.7.2", name: "snapsolve" });
    expect(existsSync(path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "snapsolve.lnk"))).toBe(true);
    expect(readFileSync(path.join(data, "app", "current", "main.js"), "utf8")).toBe("// main 0.2.0\n");
    expect(JSON.parse(readFileSync(path.join(data, "config.json"), "utf8")).claudePath).toBe(path.join(tmp, "bin", "claude.exe"));
    expect(JSON.parse(readFileSync(path.join(data, "app", "install.json"), "utf8"))).toEqual({
      version: "0.2.0",
      electronVersion: "44.7.2",
      exe,
    });
    expect(launches()).toEqual([exe]);
    const npm = readFileSync(path.join(tmp, "npm.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(npm).toHaveLength(1);
    expect(path.dirname(npm[0].cwd)).toBe(path.join(data, "app"));
  });

  it("doctor → ok on every line except the smoke check, which cannot run the fake launcher", () => {
    const r = cli("doctor");
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const notOk = r.lines.filter((l) => !l.startsWith("ok:"));
    expect(notOk).toHaveLength(1);
    expect(notOk[0]).toMatch(/^fail: .*snapsolve\.exe --smoke/);
    expect(r.stdout).toContain("2.1.300 (Claude Code)");
  });

  it("start → launches the installed exe", () => {
    const r = cli("start");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(launches()).toHaveLength(2);
  });

  it("update to a bumped payload → current flips to 0.3.0, no repackaging, relaunched; same again → up to date", () => {
    writePayload("0.3.0");
    const packaged = readFileSync(path.join(local, "Programs", "snapsolve", "options.json"), "utf8");
    const r = cli("update");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(path.join(data, "app", "current", "main.js"), "utf8")).toBe("// main 0.3.0\n");
    expect(JSON.parse(readFileSync(path.join(data, "app", "install.json"), "utf8")).version).toBe("0.3.0");
    expect(readFileSync(path.join(local, "Programs", "snapsolve", "options.json"), "utf8")).toBe(packaged);
    expect(launches()).toHaveLength(3);
    expect(readdirSync(path.join(data, "app")).sort()).toEqual(["0.2.0", "0.3.0", "current", "install.json"]);

    const again = cli("update");
    expect(again.status).toBe(0);
    expect(again.lines).toEqual([expect.stringMatching(/^ok: .*up to date/)]);
  });

  it("uninstall → launcher, shortcut and app gone; history, config and logs stay", () => {
    mkdirSync(path.join(data, "threads", "t1"), { recursive: true });
    writeFileSync(path.join(data, "threads", "t1", "thread.json"), "{}");
    mkdirSync(path.join(data, "logs"), { recursive: true });
    writeFileSync(path.join(data, "logs", "snapsolve.log"), "{}\n");

    const r = cli("uninstall");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(path.join(local, "Programs", "snapsolve"))).toBe(false);
    expect(existsSync(path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "snapsolve.lnk"))).toBe(false);
    expect(readdirSync(data).sort()).toEqual(["config.json", "logs", "threads"]);
  });

  it("uninstall --purge → no data dir; nothing was written to the real per-user locations", () => {
    const r = cli("uninstall", "--purge");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(REAL.map((p) => existsSync(p))).toEqual(realBefore);
  });
});
