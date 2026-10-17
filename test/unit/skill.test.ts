import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataPaths, resolveDataDir } from "../../src/main/paths";
import { repoRoot } from "../paths";

const SKILL = path.join(repoRoot, "plugin", "skills", "snapsolve", "SKILL.md");
const SUBCOMMANDS = ["install", "start", "update", "doctor", "uninstall"] as const;
const SCRIPT_REF = '"${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs"';
const command = (sub: string) => `node ${SCRIPT_REF} ${sub}`;

const text = readFileSync(SKILL, "utf8");

function frontmatter(): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");

/** `## <heading>` → its text up to the next `## ` heading. */
function sections(): Map<string, string> {
  const map = new Map<string, string>();
  const parts = body.split(/^## /m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    map.set(part.slice(0, newline).trim(), part.slice(newline + 1));
  }
  return map;
}

const intro = body.split(/^## /m)[0];

describe("SKILL.md frontmatter", () => {
  it("name snapsolve, a description naming all five subcommands, user-invoked only", () => {
    const fm = frontmatter();
    expect(fm.name).toBe("snapsolve");
    // Whole words: "install" must not be satisfied by "uninstall".
    for (const sub of SUBCOMMANDS) expect(fm.description).toMatch(new RegExp(`\\b${sub}\\b`));
    expect(fm["disable-model-invocation"]).toBe("true");
  });

  it("every unquoted value is a valid YAML plain scalar (no ': ' or ' #' inside)", () => {
    for (const [key, value] of Object.entries(frontmatter())) {
      if (/^["']/.test(value)) continue;
      expect(value, key).not.toMatch(/: | #/);
    }
  });

  // Claude Code drops every frontmatter field when the block is not valid YAML, disable-model-invocation included.
  it("every frontmatter line is one `key: value` whose value is a safe YAML scalar", () => {
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text)![1];
    for (const line of block.split("\n")) {
      const kv = /^([A-Za-z-]+): (.+)$/.exec(line);
      expect(kv, `not a single-line key: value → ${line}`).not.toBeNull();
      expect(yamlScalarProblem(kv![2]), line).toBeNull();
    }
  });

  it("the scalar check rejects what YAML rejects or silently changes (the old description, comments, anchors, indicators, open quotes)", () => {
    const bad = [
      "Install snapsolve (side panel). Subcommands: install, start",
      "a comment # here",
      "[unclosed",
      "{flow",
      "*alias",
      "&anchor x",
      "!tag x",
      "| block",
      "> folded",
      "% directive",
      "@reserved",
      "`reserved",
      "- item",
      "ends with colon:",
      '"open quote',
      '"inner " quote"',
      "'it's'",
    ];
    for (const value of bad) expect(yamlScalarProblem(value), value).not.toBeNull();
    for (const value of ["snapsolve", "install | start | update", "true", '"a: b"', "'it''s'", "Subcommands are install, start."]) {
      expect(yamlScalarProblem(value), value).toBeNull();
    }
  });
});

/** Why `value` is not a safe one-line YAML scalar, or null. */
function yamlScalarProblem(value: string): string | null {
  if (value.startsWith('"')) {
    return /^"(?:[^"\\]|\\.)*"$/.test(value) ? null : "double-quoted value not closed, or a bare \" inside";
  }
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? null : "single-quoted value not closed, or a lone ' inside";
  if (/^[[\]{},#&*!|>%@`]/.test(value)) return "starts with a YAML indicator";
  if (/^[-?:](\s|$)/.test(value)) return "starts with a block indicator";
  if (/: |:$/.test(value)) return "': ' or a trailing ':' inside a plain scalar";
  if (/ #/.test(value)) return "' #' starts a comment";
  return null;
}

describe("SKILL.md subcommands", () => {
  for (const sub of SUBCOMMANDS) {
    it(`## ${sub} runs exactly \`snapsolve.mjs ${sub}\` and no other subcommand`, () => {
      const section = sections().get(sub);
      expect(section, `no "## ${sub}" section`).toBeDefined();
      // Whole lines: `uninstall` must not be satisfied by the `uninstall --purge` line.
      const commandLines = section!.split("\n").filter((l) => l.includes("snapsolve.mjs"));
      const allowed = sub === "uninstall" ? [command("uninstall"), command("uninstall --purge")] : [command(sub)];
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) expect(allowed).toContain(line);
      for (const expected of allowed) expect(commandLines.filter((l) => l === expected), expected).toHaveLength(1);
    });
  }

  it("the script every command runs exists in the plugin", () => {
    const rel = SCRIPT_REF.slice('"${CLAUDE_PLUGIN_ROOT}/'.length, -1);
    expect(existsSync(path.join(repoRoot, "plugin", ...rel.split("/")))).toBe(true);
  });

  it("the intro takes the subcommand from $ARGUMENTS and lists all five for no or an unknown argument", () => {
    expect(intro).toContain("$ARGUMENTS");
    for (const sub of SUBCOMMANDS) expect(intro).toContain(`\`${sub}\``);
    expect(intro).toMatch(/unknown|not one of/i);
  });
});

describe("SKILL.md plugin-root references", () => {
  it("every reference is the braced ${CLAUDE_PLUGIN_ROOT} followed by a forward-slash path", () => {
    const refs = [...text.matchAll(/CLAUDE_PLUGIN_ROOT/g)];
    expect(refs.length).toBeGreaterThanOrEqual(SUBCOMMANDS.length);
    for (const ref of refs) {
      const i = ref.index!;
      expect(text.slice(i - 2, i), "must be ${…}").toBe("${");
      expect(text.slice(i + "CLAUDE_PLUGIN_ROOT".length, i + "CLAUDE_PLUGIN_ROOT".length + 2)).toBe("}/");
      const pathEnd = text.indexOf('"', i);
      expect(text.slice(i, pathEnd)).not.toContain("\\");
    }
    expect(text).not.toMatch(/\$CLAUDE_PLUGIN_ROOT|%CLAUDE_PLUGIN_ROOT%|\$env:CLAUDE_PLUGIN_ROOT/);
  });
});

describe("SKILL.md uninstall --purge", () => {
  it("--purge appears only in the uninstall section, after the instruction to ask the user first", () => {
    const uninstall = sections().get("uninstall")!;
    const total = text.split("--purge").length - 1;
    const inUninstall = uninstall.split("--purge").length - 1;
    expect(inUninstall).toBe(1);
    expect(total).toBe(1);
    const ask = uninstall.search(/ask the user/i);
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(ask).toBeLessThan(uninstall.indexOf("--purge"));
    expect(uninstall).toContain(command("uninstall --purge"));
  });

  it("history is kept unless the user says yes: the plain uninstall runs for anything else", () => {
    const uninstall = sections().get("uninstall")!;
    const lines = uninstall.split("\n");
    const purge = lines.indexOf(command("uninstall --purge"));
    const keep = lines.indexOf(command("uninstall"));
    expect(purge).toBeGreaterThan(0);
    expect(keep).toBeGreaterThan(0);
    expect(lines.slice(0, purge).join("\n")).toMatch(/explicit yes/i);
    expect(lines.slice(purge + 1, keep).join("\n")).toMatch(/anything else/i);
  });
});

describe("SKILL.md install and doctor notes", () => {
  it("install: winget offer only after a yes, the Pro-plan note, the AltGr note and the three proxy variables", () => {
    const install = sections().get("install")!;
    expect(install).toContain("winget install OpenJS.NodeJS.LTS");
    expect(install).toMatch(/only after (they|the user) (say|says|answer|answers) yes/i);
    expect(install).toMatch(/Pro plan/);
    expect(install).toMatch(/5-hour/);
    expect(install).toMatch(/7-day/);
    expect(install).toContain('"model": "sonnet"');
    expect(install).toMatch(/AltGr/);
    for (const layout of ["German", "French", "Polish"]) expect(install).toContain(layout);
    for (const variable of ["ELECTRON_MIRROR", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]) expect(install).toContain(variable);
  });

  it("macOS (031): brew offer, the Screen Recording grant + Relaunch after install, the re-prompt note on update", () => {
    const install = sections().get("install")!;
    expect(install).toContain("brew install node");
    expect(install).toMatch(/Screen Recording/);
    expect(install).toMatch(/Relaunch/);
    expect(install).toContain("Ctrl+Option+C");
    expect(install).not.toContain("Ctrl+Option+Q");
    const update = sections().get("update")!;
    expect(update).toMatch(/Screen Recording/);
    expect(intro).not.toMatch(/Windows-only/);
  });

  it("doctor: asks the Ctrl+Alt+C question after the script", () => {
    const doctor = sections().get("doctor")!;
    const question = "Press Ctrl+Alt+C now — did a card appear with an answer?";
    expect(doctor).toContain(question);
    expect(doctor.indexOf(question)).toBeGreaterThan(doctor.indexOf(command("doctor")));
  });
});

describe("SKILL.md doctor paths (037)", () => {
  const WIN_LOG = String.raw`%LOCALAPPDATA%\snapsolve\logs\snapsolve.log`;
  const WIN_CONFIG = String.raw`%LOCALAPPDATA%\snapsolve\config.json`;

  /** A data-dir file as SKILL.md writes it on Windows (`%LOCALAPPDATA%\snapsolve\…`), from the app's own rules. */
  function windowsPath(pick: (p: ReturnType<typeof dataPaths>) => string): string {
    const root = String.raw`C:\LAD`;
    const dir = resolveDataDir("win32", { LOCALAPPDATA: root }, String.raw`C:\home`);
    const rel = path.relative(dir, pick(dataPaths(dir))).split(/[\\/]/).join("\\");
    return `${dir.replace(root, "%LOCALAPPDATA%")}\\${rel}`;
  }

  it("the doctor section names the Windows log and config files in the data folder", () => {
    const doctor = sections().get("doctor")!;
    expect(doctor).toContain(WIN_LOG);
    expect(doctor).toContain(WIN_CONFIG);
    expect(doctor).not.toMatch(/the folder the output names/);
  });

  it("those paths are the app's data dir rules (resolveDataDir + dataPaths), not a guess", () => {
    expect(windowsPath((p) => p.logFile)).toBe(WIN_LOG);
    expect(windowsPath((p) => p.config)).toBe(WIN_CONFIG);
  });

  it("the hotkey question uses hotkeys.capture from that config file when it is not the default", () => {
    const doctor = sections().get("doctor")!;
    const after = doctor.slice(doctor.indexOf("Press Ctrl+Alt+C now"));
    expect(after).toContain("`hotkeys.capture`");
    expect(after).toContain(WIN_CONFIG);
    expect(doctor).not.toMatch(/If they changed the hotkey, use theirs/);
  });

  // The Windows-separator form only; the Mac path (forward slashes) is checked in the 039 block for both platforms.
  it("the Windows log path always carries its folder (no bare logs\\snapsolve.log)", () => {
    const doctor = sections().get("doctor")!;
    expect(doctor.replaceAll(WIN_LOG, "")).not.toMatch(/logs\\snapsolve\.log/);
  });
});

describe("SKILL.md doctor paths on a Mac (039)", () => {
  const MAC_LOG = "~/Library/Application Support/snapsolve/logs/snapsolve.log";
  const MAC_CONFIG = "~/Library/Application Support/snapsolve/config.json";

  /** A data-dir file as SKILL.md writes it on a Mac (`~/Library/Application Support/snapsolve/…`), from the app's rules. */
  function macPath(pick: (p: ReturnType<typeof dataPaths>) => string): string {
    const home = "/HOME";
    const dir = resolveDataDir("darwin", {}, home);
    const rel = path.relative(dir, pick(dataPaths(dir))).split(/[\\/]/).join("/");
    return `${dir.replace(home, "~")}/${rel}`;
  }

  it("the doctor section names the Mac log and config files", () => {
    const doctor = sections().get("doctor")!;
    expect(doctor).toContain(MAC_LOG);
    expect(doctor).toContain(MAC_CONFIG);
  });

  it("those paths are the app's data dir rules (resolveDataDir darwin + dataPaths)", () => {
    expect(macPath((p) => p.logFile)).toBe(MAC_LOG);
    expect(macPath((p) => p.config)).toBe(MAC_CONFIG);
  });

  it("the Mac paths sit next to the Windows ones: config with the hotkey question, log with the no-card checks", () => {
    const doctor = sections().get("doctor")!;
    const hotkey = doctor.split("\n").find((l) => l.includes("`hotkeys.capture`"))!;
    expect(hotkey).toContain(MAC_CONFIG);
    expect(hotkey).toContain(String.raw`%LOCALAPPDATA%\snapsolve\config.json`);
    const noCard = doctor.split("\n").find((l) => l.startsWith("If no card appeared"))!;
    expect(noCard).toContain(MAC_LOG);
    expect(noCard).toContain(String.raw`%LOCALAPPDATA%\snapsolve\logs\snapsolve.log`);
  });

  it("every log path in the doctor section carries its folder on both platforms", () => {
    const doctor = sections().get("doctor")!;
    const rest = doctor.replaceAll(String.raw`%LOCALAPPDATA%\snapsolve\logs\snapsolve.log`, "").replaceAll(MAC_LOG, "");
    expect(rest).not.toMatch(/logs[\\/]snapsolve\.log/);
  });
});

describe("SKILL.md hygiene", () => {
  it("LF line endings only, no absolute user paths", () => {
    expect(text).not.toContain("\r\n");
    expect(text).not.toMatch(/C:\\Users|\/Users\//);
  });
});

describe("DESIGN §10 risk 1", () => {
  it("is marked resolved", () => {
    const design = readFileSync(path.join(repoRoot, "DESIGN.md"), "utf8");
    const line = design.split("\n").find((l) => l.startsWith("1. `${CLAUDE_PLUGIN_ROOT}`"));
    expect(line).toMatch(/Resolved/);
  });
});
