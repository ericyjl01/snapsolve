// JSON-lines logger for <data>/logs/snapsolve.log: redacts sensitive keys, rotates at 5 MB, never throws.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Resolves once every line logged so far is written or has failed. Never rejects. */
  flush(): Promise<void>;
}

export interface LoggerOptions {
  maxBytes?: number;
  now?: () => Date;
  /** Receives the single note written when the log cannot be written. */
  stderr?: (message: string) => void;
}

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Keys whose values may hold screenshots, prompts, answers or personal data (ARCHITECTURE `## Do NOT`).
const SENSITIVE_KEYS = new Set(["data", "image", "base64", "text", "prompt", "answer", "email"]);
const RESERVED_KEYS = ["ts", "level", "event"];

/**
 * Appends one JSON line per call (`ts`, `level`, `event`, then the fields) in call order. When the next line
 * would push the file past `maxBytes`, the file moves to `<file>.1` first (replacing it). Write failures are
 * swallowed after one note on stderr, so logging can never take the app down.
 */
export function createLogger(file: string, options: LoggerOptions = {}): Logger {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const now = options.now ?? (() => new Date());
  const stderr = options.stderr ?? ((message: string) => void process.stderr.write(message));
  let size: number | null = null; // bytes in `file`; read from disk before the first write and after a failure
  let noted = false;
  let queue: Promise<void> = Promise.resolve();

  function note(e: unknown): void {
    if (noted) return;
    noted = true;
    try {
      stderr(`snapsolve: cannot write log ${file}: ${describe(e)}\n`);
    } catch {
      // nowhere left to report to
    }
  }

  async function append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    size ??= await sizeOnDisk(file);
    if (size > 0 && size + bytes > maxBytes) {
      try {
        await rename(file, `${file}.1`);
        size = 0;
      } catch (e) {
        note(e); // keep appending to the full file rather than drop lines
      }
    }
    try {
      await appendFile(file, line);
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line);
    }
    size += bytes;
  }

  function write(level: LogLevel, event: string, fields?: LogFields): void {
    try {
      const line = `${format(now(), level, event, fields)}\n`;
      queue = queue
        .then(() => append(line))
        .catch((e: unknown) => {
          size = null;
          note(e);
        });
    } catch (e) {
      note(e);
    }
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    flush: () => queue,
  };
}

function format(ts: Date, level: LogLevel, event: string, fields?: LogFields): string {
  const head = { ts: ts.toISOString(), level, event };
  try {
    const body = fields ? (sanitize(fields, new Set()) as Record<string, unknown>) : {};
    for (const key of RESERVED_KEYS) delete body[key];
    return JSON.stringify({ ...head, ...body });
  } catch {
    return JSON.stringify({ ...head, logError: "fields could not be serialized" });
  }
}

/** A JSON-safe copy of `value`: sensitive keys redacted, bytes as their size, errors expanded, cycles cut. */
function sanitize(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => sanitize(v, ancestors));
    if (value instanceof Error) {
      const out: Record<string, unknown> = { name: value.name, message: value.message };
      copyEntries(value, out, ancestors);
      if (value.cause !== undefined) out.cause = sanitize(value.cause, ancestors);
      if (value.stack) out.stack = value.stack;
      return out;
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return sanitize(toJSON.call(value), ancestors);
    return copyEntries(value, {}, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function copyEntries(from: object, to: Record<string, unknown>, ancestors: Set<object>): Record<string, unknown> {
  for (const [key, v] of Object.entries(from)) {
    to[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : sanitize(v, ancestors);
  }
  return to;
}

async function sizeOnDisk(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return 0;
    throw e;
  }
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function describe(e: unknown): string {
  return errorCode(e) ?? (e instanceof Error ? e.message : String(e));
}
