// config.json: defaults (SPEC §6.1), per-field validation, created if missing, never rewritten once it exists.
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Config, Effort, Hotkeys } from "../shared/types";
import type { Logger } from "./log";

export const DEFAULTS: Readonly<Config> = Object.freeze({
  hotkeys: Object.freeze({ capture: "Control+Alt+C", append: "Control+Alt+Shift+Q", toggle: "Control+Alt+X" }),
  model: "opus",
  effort: "high",
  panelWidth: 420,
  autoHideSec: 0,
  claudePath: null,
  allowApiKey: false,
  maxConcurrent: 2,
  maxScreenshotsPerThread: 6,
  timeoutSec: 180,
});

export interface LoadedConfig {
  config: Config;
  /** One entry per value that fell back to its default or was ignored. */
  warnings: string[];
  /** True when the file was missing and has just been written with the defaults. */
  created: boolean;
}

/**
 * Reads `file`; invalid or unknown values fall back to defaults with one warning each (also logged as
 * `config.warning` when `log` is given). A missing file is created with the defaults; an existing file is
 * never written, even when it is invalid.
 */
export async function loadConfig(file: string, options: { log?: Pick<Logger, "warn"> } = {}): Promise<LoadedConfig> {
  const loaded = await read(file);
  for (const message of loaded.warnings) options.log?.warn("config.warning", { file, message });
  return loaded;
}

async function read(file: string, mayCreate = true): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT" && mayCreate) return create(file);
    return { config: defaults(), warnings: [`cannot read ${file} (${describe(e)}); using defaults`], created: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { config: defaults(), warnings: [`config.json is not valid JSON (${describe(e)}); using defaults`], created: false };
  }
  return { ...validate(raw), created: false };
}

/**
 * Atomic create (SPEC §5.1): the defaults go to a synced temp file beside `file`, which is then published with
 * `link`. Unlike rename, link fails instead of replacing a config.json that appeared after the read; that file
 * is read instead. A crash leaves either no config.json or a complete one.
 */
async function create(file: string): Promise<LoadedConfig> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(DEFAULTS, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temp, file);
    return { config: defaults(), warnings: [], created: true };
  } catch (e) {
    if (errorCode(e) === "EEXIST") return await read(file, false);
    return { config: defaults(), warnings: [`cannot create ${file} (${describe(e)}); using defaults`], created: false };
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

type FieldKey = Exclude<keyof Config, "hotkeys">;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
// An alias ("opus") or a full id ("claude-opus-5-5[1m]"); no spaces, so it stays one CLI argument.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

const intIn =
  (min: number, max: number) =>
  (v: unknown): boolean =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const FIELDS: Record<FieldKey, { valid: (v: unknown) => boolean; expected: string }> = {
  model: { valid: (v) => typeof v === "string" && MODEL.test(v), expected: 'a model name such as "opus"' },
  effort: { valid: (v) => EFFORTS.includes(v as Effort), expected: `one of ${EFFORTS.join(", ")}` },
  panelWidth: { valid: intIn(240, 2000), expected: "an integer from 240 to 2000" },
  autoHideSec: { valid: intIn(0, 86_400), expected: "an integer from 0 (never) to 86400" },
  claudePath: {
    valid: (v) => v === null || (typeof v === "string" && path.isAbsolute(v)),
    expected: "null or an absolute path",
  },
  allowApiKey: { valid: (v) => typeof v === "boolean", expected: "true or false" },
  maxConcurrent: { valid: intIn(1, 8), expected: "an integer from 1 to 8" },
  maxScreenshotsPerThread: { valid: intIn(1, 20), expected: "an integer from 1 to 20" },
  timeoutSec: { valid: intIn(10, 3600), expected: "an integer from 10 to 3600" },
};

function validate(raw: unknown): { config: Config; warnings: string[] } {
  const config = defaults();
  const warnings: string[] = [];
  if (!isObject(raw)) {
    warnings.push("config.json must contain a JSON object; using defaults");
    return { config, warnings };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "hotkeys") {
      config.hotkeys = validateHotkeys(value, warnings);
    } else if (Object.hasOwn(FIELDS, key)) {
      const field = FIELDS[key as FieldKey];
      if (field.valid(value)) Object.assign(config, { [key]: value });
      else warnings.push(invalid(key, field.expected, value, DEFAULTS[key as FieldKey]));
    } else {
      warnings.push(`unknown key "${key}" ignored`);
    }
  }
  return { config, warnings };
}

function validateHotkeys(raw: unknown, warnings: string[]): Hotkeys {
  const hotkeys = { ...DEFAULTS.hotkeys };
  if (!isObject(raw)) {
    warnings.push(invalid("hotkeys", "an object with capture, append and toggle", raw, DEFAULTS.hotkeys));
    return hotkeys;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!HOTKEY_NAMES.includes(key as keyof Hotkeys)) {
      warnings.push(`unknown key "hotkeys.${key}" ignored`);
    } else if (typeof value === "string" && normalizeAccelerator(value) !== null) {
      hotkeys[key as keyof Hotkeys] = value;
    } else {
      warnings.push(invalid(`hotkeys.${key}`, 'an Electron accelerator such as "Control+Alt+C"', value, DEFAULTS.hotkeys[key as keyof Hotkeys]));
    }
  }
  for (const [i, a] of HOTKEY_NAMES.entries()) {
    for (const b of HOTKEY_NAMES.slice(i + 1)) {
      if (normalizeAccelerator(hotkeys[a]) === normalizeAccelerator(hotkeys[b])) {
        warnings.push(`"hotkeys.${a}" and "hotkeys.${b}" are the same key ("${hotkeys[a]}"); using defaults for all hotkeys`);
        return { ...DEFAULTS.hotkeys };
      }
    }
  }
  return hotkeys;
}

const HOTKEY_NAMES: readonly (keyof Hotkeys)[] = ["capture", "append", "toggle"];

// Electron accelerator grammar (https://www.electronjs.org/docs/latest/api/accelerator), case-insensitive.
const MODIFIERS: Record<string, string> = {
  command: "command",
  cmd: "command",
  control: "control",
  ctrl: "control",
  commandorcontrol: "commandorcontrol",
  cmdorctrl: "commandorcontrol",
  alt: "alt",
  option: "alt",
  altgr: "altgr",
  shift: "shift",
  super: "super",
  meta: "super",
};
const KEY_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };
const NAMED_KEYS = new Set([
  "plus", "space", "tab", "capslock", "numlock", "scrolllock", "backspace", "delete", "insert", "enter",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "escape", "printscreen",
  "volumeup", "volumedown", "volumemute", "medianexttrack", "mediaprevioustrack", "mediastop", "mediaplaypause",
  "numdec", "numadd", "numsub", "nummult", "numdiv",
]);
// "+" is the separator, so the plus key is spelled "Plus".
const PUNCTUATION = new Set([..."`~!@#$%^&*()-_=[]{}\\|;:'\",<.>/?"]);

/**
 * Canonical form ("alt+control+q") of a valid accelerator, or null. Besides Electron's grammar, a hotkey
 * needs a modifier other than Shift unless it is F1–F24: a global "Q" or "Shift+Q" would swallow typing.
 */
function normalizeAccelerator(accelerator: string): string | null {
  const tokens = accelerator.split("+");
  if (tokens.some((t) => t === "")) return null;
  const last = tokens.at(-1)!.toLowerCase();
  const key = KEY_ALIASES[last] ?? last;
  const isFunctionKey = /^f([1-9]|1\d|2[0-4])$/.test(key);
  const isKey =
    /^[a-z0-9]$/.test(key) || isFunctionKey || /^num\d$/.test(key) || NAMED_KEYS.has(key) || PUNCTUATION.has(key);
  if (!isKey) return null;
  const modifiers = new Set<string>();
  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIERS[token.toLowerCase()];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  if (!isFunctionKey && ![...modifiers].some((m) => m !== "shift")) return null;
  return [...[...modifiers].sort(), key].join("+");
}

function defaults(): Config {
  return structuredClone(DEFAULTS) as Config;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(key: string, expected: string, got: unknown, fallback: unknown): string {
  const shown = JSON.stringify(got) ?? String(got);
  const clipped = shown.length > 60 ? `${shown.slice(0, 57)}...` : shown;
  return `"${key}" must be ${expected} (got ${clipped}); using ${JSON.stringify(fallback)}`;
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function describe(e: unknown): string {
  return errorCode(e) ?? (e instanceof Error ? e.message : String(e));
}
