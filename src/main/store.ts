// Threads on disk (SPEC §5.1): threads/<id>/thread.json, NNN.png screenshots and the thread's own Claude
// transcript (§3.4). Every write is atomic; mutations of one thread run one at a time, in call order.
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SnapsolveError } from "../shared/errors";
import type { Effort, Thread, ThreadStatus, Turn } from "../shared/types";
import type { Logger } from "./log";
import { dataPaths } from "./paths";

/** Ids and session ids are `crypto.randomUUID()` output: lowercase v4. Anything else is not ours. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCREENSHOT = /^(\d{3})\.png$/;
const MAX_SCREENSHOT = 999;
// Stats in flight at once while scanning ~/.claude/projects for a transcript (task 046).
const SCAN_CONCURRENCY = 32;
const STATUSES: readonly ThreadStatus[] = ["new", "queued", "running", "done", "error"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Codes Windows returns while another process (Defender, the search indexer) briefly holds a rename's file. */
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Waits between rename tries: 200 ms in total. */
const RENAME_DELAYS_MS = [10, 20, 30, 40, 50, 50];

export interface StoreDeps {
  /** The data dir (`resolveDataDir`); threads/ and sessions/ live under it. */
  dataDir: string;
  /** Claude Code's transcript root, `~/.claude/projects`. */
  projectsDir: string;
  /** Runs `claude purge "<sessionsDir>" -y`; injected so the store never spawns. */
  purge: (sessionsDir: string) => Promise<void>;
  log: Logger;
  now?: () => Date;
  /** `fs/promises` stat for the transcript scan; injected so a test can observe its concurrency. */
  stat?: (file: string) => Promise<Stats>;
}

export interface SavedScreenshot {
  n: number;
  /** `NNN.png`, as recorded in a screenshot turn. */
  file: string;
  path: string;
}

export type AdoptResult = { ok: true; transcriptPath: string } | { ok: false; reason: string };
export type ClearResult = { ok: true } | { ok: false; error: string };
export type ThreadPatch = Partial<Pick<Thread, "status" | "title">>;

export interface Store {
  createThread(options: { model: string; effort: Effort }): Promise<Thread>;
  saveScreenshot(id: string, png: Uint8Array): Promise<SavedScreenshot>;
  appendTurn(id: string, turn: Turn): Promise<Thread>;
  updateThread(id: string, patch: ThreadPatch): Promise<Thread>;
  /** Rejects with `threadNotFound` for a malformed id, a missing thread or an unreadable thread.json. */
  getThread(id: string): Promise<Thread>;
  /** Every readable thread, newest first. Unreadable ones are logged and skipped, never deleted. */
  listThreads(): Promise<Thread[]>;
  /** `threads/<id>/NNN.png` for 1 ≤ n ≤ 999; throws `threadNotFound` for anything else. */
  screenshotPath(id: string, n: number): string;
  /**
   * Moves the first turn's transcript `<projectsDir>/<any>/<sid>.jsonl` into the thread dir (copy, fsync,
   * delete the original) and records it as `transcriptPath`. Not found → `{ ok: false }` and the thread is
   * marked `transcriptMissing`, so the next turn takes the resume fallback.
   */
  adoptTranscript(id: string, sid: string): Promise<AdoptResult>;
  /** Starts a new session for the thread (resume fallback): new sessionId, no transcript yet, turns kept. */
  replaceSession(id: string, newSid?: string): Promise<Thread>;
  /** Deletes threads/, then purges sessions/. Failures are logged and returned; neither step is skipped. */
  clearHistory(): Promise<ClearResult>;
  writeJsonAtomic(file: string, value: unknown): Promise<void>;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Writes `value` as pretty JSON: a synced temp file beside `file`, then rename over it. On any failure the
 * previous content is untouched and the temp file is removed.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const text: unknown = JSON.stringify(value, null, 2);
  if (typeof text !== "string") throw new TypeError("value is not representable as JSON");
  const temp = tempPath(file);
  try {
    await writeSynced(temp, `${text}\n`);
    await renameRetrying(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export function createStore(deps: StoreDeps): Store {
  const { projectsDir, purge, log } = deps;
  const now = deps.now ?? (() => new Date());
  const scanStat = deps.stat ?? stat;
  const paths = dataPaths(deps.dataDir);
  const queues = new Map<string, Promise<unknown>>();

  const threadDir = (id: string) => path.join(paths.threads, checkId(id));
  const threadFile = (id: string) => path.join(threadDir(id), "thread.json");

  /** Runs `fn` after every earlier mutation of thread `id`; the id is checked before queueing. */
  function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
    try {
      checkId(id);
    } catch (e) {
      return Promise.reject(e);
    }
    const run = (queues.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  }

  async function load(id: string): Promise<Thread> {
    let text: string;
    try {
      text = await readFile(threadFile(id), "utf8");
    } catch (e) {
      const reason = errorCode(e) === "ENOENT" ? "no thread.json" : `cannot read thread.json (${describe(e)})`;
      throw new SnapsolveError("threadNotFound", `thread ${id}: ${reason}`, { cause: e });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // The parser's message quotes the file, which may hold answer text: never pass it on.
      throw new SnapsolveError("threadNotFound", `thread ${id}: thread.json is not valid JSON`);
    }
    const problem = threadProblem(raw, id);
    if (problem) throw new SnapsolveError("threadNotFound", `thread ${id}: thread.json ${problem}`);
    return raw as Thread;
  }

  async function save(thread: Thread): Promise<Thread> {
    try {
      await writeJsonAtomic(threadFile(thread.id), thread);
    } catch (e) {
      if (errorCode(e) === "ENOENT") throw new SnapsolveError("threadNotFound", `thread ${thread.id} is gone`, { cause: e });
      throw new SnapsolveError("internal", `cannot save thread ${thread.id} (${describe(e)})`, { cause: e });
    }
    return thread;
  }

  async function findTranscript(sid: string): Promise<string | null> {
    let dirs;
    try {
      dirs = await readdir(projectsDir, { withFileTypes: true });
    } catch (e) {
      if (errorCode(e) !== "ENOENT") log.warn("store.projectsUnreadable", { dir: projectsDir, error: e });
      return null;
    }
    const files = dirs.filter((d) => d.isDirectory()).map((d) => path.join(projectsDir, d.name, `${sid}.jsonl`));
    const found: { file: string; mtimeMs: number }[] = [];
    // A heavy Claude Code user has hundreds of project dirs: stat them concurrently, a bounded number at a time.
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++];
        const s = await scanStat(file).catch(() => null);
        if (s?.isFile()) found.push({ file, mtimeMs: s.mtimeMs });
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, worker));
    if (found.length > 1) log.warn("store.transcriptDuplicates", { sessionId: sid, files: found.map((f) => f.file) });
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found[0]?.file ?? null;
  }

  async function markMissing(thread: Thread, reason: string): Promise<AdoptResult> {
    log.warn("store.transcriptMissing", { threadId: thread.id, sessionId: thread.sessionId, reason });
    await save({ ...thread, transcriptMissing: true });
    return { ok: false, reason };
  }

  return {
    writeJsonAtomic,

    async createThread({ model, effort }) {
      const thread: Thread = {
        id: randomUUID(),
        sessionId: randomUUID(),
        transcriptPath: null,
        model,
        effort,
        createdAt: now().toISOString(),
        title: "",
        status: "new",
        turns: [],
      };
      const dir = threadDir(thread.id);
      try {
        await mkdir(dir, { recursive: true });
        await writeJsonAtomic(path.join(dir, "thread.json"), thread);
      } catch (e) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw new SnapsolveError("dataDirUnavailable", `cannot create thread in ${paths.threads} (${describe(e)})`, {
          cause: e,
        });
      }
      return thread;
    },

    saveScreenshot(id, png) {
      return serialized(id, async () => {
        await load(id);
        const dir = threadDir(id);
        const taken = (await readdir(dir)).map((f) => SCREENSHOT.exec(f)).filter((m) => m !== null);
        // link() refuses an existing name, so a second store instance can never overwrite a screenshot.
        for (let n = Math.max(0, ...taken.map((m) => Number(m[1]))) + 1; n <= MAX_SCREENSHOT; n++) {
          const file = `${String(n).padStart(3, "0")}.png`;
          const target = path.join(dir, file);
          const temp = tempPath(target);
          try {
            await writeSynced(temp, png);
            await link(temp, target);
            return { n, file, path: target };
          } catch (e) {
            if (errorCode(e) !== "EEXIST") throw e;
          } finally {
            await rm(temp, { force: true }).catch(() => undefined);
          }
        }
        throw new SnapsolveError("internal", `thread ${id} has ${MAX_SCREENSHOT} screenshots`);
      });
    },

    appendTurn(id, turn) {
      return serialized(id, async () => {
        const problem = turnProblem(turn);
        if (problem) throw new SnapsolveError("internal", `invalid turn: ${problem}`);
        const thread = await load(id);
        return save({ ...thread, turns: [...thread.turns, turn] });
      });
    },

    updateThread(id, patch) {
      return serialized(id, async () => {
        const next = { ...(await load(id)) };
        if (patch.status !== undefined) {
          if (!STATUSES.includes(patch.status)) throw new SnapsolveError("internal", `invalid status ${patch.status}`);
          next.status = patch.status;
        }
        if (patch.title !== undefined) {
          if (typeof patch.title !== "string") throw new SnapsolveError("internal", "title must be a string");
          next.title = patch.title;
        }
        return save(next);
      });
    },

    async getThread(id) {
      checkId(id);
      return load(id);
    },

    async listThreads() {
      let entries;
      try {
        entries = await readdir(paths.threads, { withFileTypes: true });
      } catch (e) {
        if (errorCode(e) === "ENOENT") return [];
        throw new SnapsolveError("dataDirUnavailable", `cannot list ${paths.threads} (${describe(e)})`, { cause: e });
      }
      const loaded = await Promise.all(
        entries
          .filter((d) => d.isDirectory() && isUuid(d.name))
          .map((d) =>
            load(d.name).catch((e: unknown) => {
              log.warn("store.threadUnreadable", { id: d.name, reason: e instanceof Error ? e.message : String(e) });
              return null;
            }),
          ),
      );
      return loaded
        .filter((t) => t !== null)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    },

    screenshotPath(id, n) {
      const dir = threadDir(id);
      if (!Number.isInteger(n) || n < 1 || n > MAX_SCREENSHOT) {
        throw new SnapsolveError("threadNotFound", `no screenshot ${n} in thread ${id}`);
      }
      return path.join(dir, `${String(n).padStart(3, "0")}.png`);
    },

    adoptTranscript(id, sid) {
      return serialized(id, async () => {
        if (!isUuid(sid)) throw new SnapsolveError("internal", "invalid session id");
        const thread = await load(id);
        if (thread.sessionId !== sid) {
          throw new SnapsolveError("internal", `session ${sid} is not the session of thread ${id}`);
        }
        const owned = path.join(threadDir(id), `${sid}.jsonl`);
        if (thread.transcriptPath === owned && (await stat(owned).catch(() => null))?.isFile()) {
          return { ok: true, transcriptPath: owned };
        }

        const source = await findTranscript(sid);
        if (!source) return markMissing(thread, "transcript not found");
        const temp = tempPath(owned);
        try {
          await copyFile(source, temp);
          const handle = await open(temp, "r+");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          const [copied, original] = await Promise.all([stat(temp), stat(source)]);
          if (copied.size !== original.size) throw new Error(`copied ${copied.size} of ${original.size} bytes`);
          await renameRetrying(temp, owned);
        } catch (e) {
          await rm(temp, { force: true }).catch(() => undefined);
          return markMissing(thread, `cannot copy transcript (${describe(e)})`);
        }

        const { transcriptMissing: _, ...rest } = thread;
        await save({ ...rest, transcriptPath: owned });
        try {
          await rm(source);
        } catch (e) {
          // The owned copy is complete; clear history's purge sweeps the leftover.
          log.warn("store.transcriptOriginalKept", { file: source, error: e });
        }
        return { ok: true, transcriptPath: owned };
      });
    },

    replaceSession(id, newSid = randomUUID()) {
      return serialized(id, async () => {
        if (!isUuid(newSid)) throw new SnapsolveError("internal", "invalid session id");
        // The old transcript stays in the thread dir: history is never deleted outside clear history.
        const { transcriptMissing: _, ...rest } = await load(id);
        return save({ ...rest, sessionId: newSid, transcriptPath: null });
      });
    },

    async clearHistory() {
      let error: string | undefined;
      try {
        await rm(paths.threads, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        log.error("store.clearFailed", { dir: paths.threads, error: e });
        error = `cannot delete ${paths.threads} (${describe(e)})`;
      }
      try {
        await purge(paths.sessions);
      } catch (e) {
        log.error("store.purgeFailed", { dir: paths.sessions, error: e });
        error ??= `claude purge failed (${describe(e)})`;
      }
      return error === undefined ? { ok: true } : { ok: false, error };
    },
  };
}

function checkId(id: string): string {
  if (!isUuid(id)) throw new SnapsolveError("threadNotFound", "invalid thread id");
  return id;
}

function tempPath(file: string): string {
  return `${file}.${randomUUID()}.tmp`;
}

/** `rename`, retried on a transient code; any other code, or the last try's, is thrown. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (i >= RENAME_DELAYS_MS.length || !TRANSIENT_RENAME.has(errorCode(e) ?? "")) throw e;
      await new Promise((resolve) => setTimeout(resolve, RENAME_DELAYS_MS[i]));
    }
  }
}

async function writeSynced(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Why `raw` is not a valid thread.json for thread `id`, or null. Never quotes field values. */
function threadProblem(raw: unknown, id: string): string | null {
  if (!isRecord(raw)) return "is not an object";
  if (raw.id !== id) return "belongs to another thread";
  if (!isUuid(raw.sessionId)) return "has an invalid sessionId";
  if (raw.transcriptPath !== null && !(typeof raw.transcriptPath === "string" && path.isAbsolute(raw.transcriptPath))) {
    return "has an invalid transcriptPath";
  }
  if (typeof raw.model !== "string" || raw.model === "") return "has an invalid model";
  if (!EFFORTS.includes(raw.effort as Effort)) return "has an invalid effort";
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) return "has an invalid createdAt";
  if (typeof raw.title !== "string") return "has an invalid title";
  if (!STATUSES.includes(raw.status as ThreadStatus)) return "has an invalid status";
  if (raw.transcriptMissing !== undefined && typeof raw.transcriptMissing !== "boolean") {
    return "has an invalid transcriptMissing";
  }
  if (!Array.isArray(raw.turns)) return "has no turns list";
  for (const [i, turn] of raw.turns.entries()) {
    const problem = turnProblem(turn);
    if (problem) return `turn ${i + 1}: ${problem}`;
  }
  return null;
}

function turnProblem(turn: unknown): string | null {
  if (!isRecord(turn)) return "not an object";
  if (turn.role === "user") {
    if (turn.kind === "screenshot") {
      if (typeof turn.file !== "string" || !SCREENSHOT.test(turn.file)) return "invalid screenshot file";
      if (turn.text !== undefined && typeof turn.text !== "string") return "invalid text";
      if (turn.seed !== undefined && typeof turn.seed !== "string") return "invalid seed";
      return null;
    }
    if (turn.kind === "text") return typeof turn.text === "string" ? null : "invalid text";
    return "invalid user turn kind";
  }
  if (turn.role === "assistant") {
    if (typeof turn.text !== "string") return "invalid text";
    if (typeof turn.durationMs !== "number") return "invalid durationMs";
    if (turn.ttftMs !== null && typeof turn.ttftMs !== "number") return "invalid ttftMs";
    if (turn.costUsd !== null && typeof turn.costUsd !== "number") return "invalid costUsd";
    if (typeof turn.isError !== "boolean") return "invalid isError";
    return null;
  }
  return "invalid role";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function describe(e: unknown): string {
  return errorCode(e) ?? (e instanceof Error ? e.message : String(e));
}
