import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../../src/main/log";
import { createRunner, type Command, type RunnerEvent } from "../../src/main/runner";
import { createStore, type Store } from "../../src/main/store";
import { fixturesDir } from "../paths";

const FAKE = path.join(fixturesDir, "fake-claude.mjs");
const PROMPT = "You are snapsolve. Answer concisely.";
/** A succeeded turn; when a turn fails, toEqual prints its kind and message. */
const OK = { ok: true, thread: expect.anything() };

interface FakeLogEntry {
  event: "start" | "end";
  pid: number;
  time: number;
  argv?: string[];
  env?: string[];
  cwd?: string;
  code?: number;
  stdin?: { message: { content: { type: string; text?: string; source?: { media_type: string } }[] } };
}

let root: string;
let dataDir: string;
let projects: string;
let fakeLog: string;
let store: Store;
const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };

beforeEach(async () => {
  // Canonical, so paths compare equal to the child's process.cwd() (macOS tmpdir is under the /var → /private/var link).
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "snapsolve-runner-int-")));
  dataDir = path.join(root, "data");
  projects = path.join(root, "projects");
  fakeLog = path.join(root, "fake.log");
  store = createStore({ dataDir, projectsDir: projects, purge: async () => {}, log: quietLog });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function makeRunner(
  scenario: string,
  options: { maxConcurrent?: number; timeoutSec?: number; command?: Command | (() => Command); delayMs?: number; log?: Logger } = {},
) {
  const runner = createRunner({
    command: options.command ?? { path: process.execPath, prefixArgs: [FAKE] },
    store,
    config: { maxConcurrent: options.maxConcurrent ?? 2, timeoutSec: options.timeoutSec ?? 30, allowApiKey: false },
    systemPrompt: PROMPT,
    env: {
      ...process.env,
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_PROJECTS: projects,
      FAKE_LOG: fakeLog,
      FAKE_DELAY_MS: String(options.delayMs ?? 600),
    },
    spawn,
    sessionsDir: path.join(dataDir, "sessions"),
    log: options.log ?? quietLog,
    loadSendImage: async (file) => ({ mediaType: "image/png", data: (await readFile(file)).toString("base64") }),
  });
  const events: RunnerEvent[] = [];
  runner.on((e) => events.push(e));
  return { runner, events };
}

async function fakeEntries(): Promise<FakeLogEntry[]> {
  if (!existsSync(fakeLog)) return [];
  return (await readFile(fakeLog, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FakeLogEntry);
}

/** Every file still under the fake projects dir (claude's `~/.claude/projects`). */
async function leftInProjects(): Promise<string[]> {
  if (!existsSync(projects)) return [];
  const left: string[] = [];
  for (const d of await readdir(projects)) left.push(...(await readdir(path.join(projects, d))).map((f) => path.join(d, f)));
  return left;
}

async function newThread(png = "png-1") {
  const t = await store.createThread({ model: "opus", effort: "high" });
  const shot = await store.saveScreenshot(t.id, Buffer.from(png));
  return { t, shot };
}

const deltas = (events: RunnerEvent[], threadId: string) =>
  events
    .filter((e) => e.type === "delta" && e.threadId === threadId)
    .map((e) => (e as { text: string }).text)
    .join("");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runner with the fake claude", () => {
  it("ok: deltas in order, done carries the result fields, the transcript moves into the thread dir", async () => {
    const { runner, events } = makeRunner("ok");
    const { t, shot } = await newThread();
    const outcome = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(outcome).toEqual(OK);
    expect(deltas(events, t.id)).toBe("Answer 1: saw 1 image(s).");
    const done = events.at(-1) as Extract<RunnerEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.turn).toEqual({
      role: "assistant",
      text: "Answer 1: saw 1 image(s).",
      durationMs: 1234,
      ttftMs: 321,
      costUsd: 0.0123,
      isError: false,
      usage: "5h 12% · 7d 34%",
    });

    const owned = path.join(dataDir, "threads", t.id, `${t.sessionId}.jsonl`);
    const saved = await store.getThread(t.id);
    expect(saved.transcriptPath).toBe(owned);
    expect((await readFile(owned, "utf8")).trim().split("\n")).toHaveLength(2);
    for (const d of await readdir(projects)) expect(await readdir(path.join(projects, d))).toEqual([]);

    const [start] = await fakeEntries();
    expect(start.cwd).toBe(path.join(dataDir, "sessions"));
    expect(start.argv).toContain("--session-id");
    expect(start.env).not.toContain("CLAUDECODE");
    expect(start.env).not.toContain("CLAUDE_CODE_ENTRYPOINT");
    expect(start.env).not.toContain("ANTHROPIC_API_KEY");
    expect(start.env).toContain("FAKE_LOG");
    expect(start.stdin?.message.content.map((b) => b.type)).toEqual(["image", "text"]);
  });

  it("a data dir reached through a symlink: claude runs in its sessions dir and the transcript is still adopted", async () => {
    const real = path.join(root, "real-data");
    await mkdir(real);
    dataDir = path.join(root, "linked-data");
    await symlink(real, dataDir, process.platform === "win32" ? "junction" : "dir");
    store = createStore({ dataDir, projectsDir: projects, purge: async () => {}, log: quietLog });
    const { runner } = makeRunner("ok");
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual(OK);

    const [start] = await fakeEntries();
    expect(await realpath(start.cwd as string)).toBe(await realpath(path.join(dataDir, "sessions")));
    const owned = path.join(dataDir, "threads", t.id, `${t.sessionId}.jsonl`);
    expect((await store.getThread(t.id)).transcriptPath).toBe(owned);
    expect(existsSync(path.join(real, "threads", t.id, `${t.sessionId}.jsonl`))).toBe(true);
    expect(await leftInProjects()).toEqual([]);
  });

  it("a follow-up resumes by absolute transcript path and the fake appends to that file", async () => {
    const { runner, events } = makeRunner("ok");
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual(OK);
    const owned = (await store.getThread(t.id)).transcriptPath as string;
    const outcome = await runner.enqueue(t.id, { kind: "followUp", text: "Why divide by 2?" });
    expect(outcome).toEqual(OK);

    const second = (await fakeEntries()).filter((e) => e.event === "start")[1];
    expect(second.argv?.slice(-2)).toEqual(["--resume", owned]);
    expect(path.isAbsolute(owned)).toBe(true);
    expect(second.argv).not.toContain("--session-id");
    expect(second.stdin?.message.content).toEqual([{ type: "text", text: "Why divide by 2?" }]);
    expect((await readFile(owned, "utf8")).trim().split("\n")).toHaveLength(4);
    expect((events.at(-1) as { turn: { text: string } }).turn.text).toBe("Answer 2: saw 0 image(s).");
    expect((await store.getThread(t.id)).turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("per-thread FIFO: turn 2 starts after turn 1 exits", async () => {
    const { runner } = makeRunner("slow");
    const { t, shot } = await newThread();
    const outcomes = await Promise.all([
      runner.enqueue(t.id, { kind: "new", screenshot: shot.file }),
      runner.enqueue(t.id, { kind: "followUp", text: "and then?" }),
    ]);
    expect(outcomes).toEqual([OK, OK]);
    const log = await fakeEntries();
    const [s1, s2] = log.filter((e) => e.event === "start");
    const e1 = log.find((e) => e.event === "end" && e.pid === s1.pid) as FakeLogEntry;
    expect(s2.time).toBeGreaterThanOrEqual(e1.time);
    expect(s2.argv).toContain("--resume");
  });

  it("cap 2: a third thread waits with status queued and starts after one finishes", async () => {
    const { runner, events } = makeRunner("slow", { maxConcurrent: 2 });
    const threads = [await newThread("a"), await newThread("b"), await newThread("c")];
    const outcomes = await Promise.all(threads.map(({ t, shot }) => runner.enqueue(t.id, { kind: "new", screenshot: shot.file })));
    expect(outcomes).toEqual([OK, OK, OK]);
    const third = threads[2].t.id;
    expect(events.find((e) => e.type === "status" && e.threadId === third)).toMatchObject({ status: "queued" });
    for (const { t } of threads.slice(0, 2)) {
      expect(events.some((e) => e.type === "status" && e.threadId === t.id && e.status === "queued")).toBe(false);
    }

    const log = await fakeEntries();
    const runs = log
      .filter((e) => e.event === "start")
      .map((s) => ({ start: s.time, end: (log.find((e) => e.event === "end" && e.pid === s.pid) as FakeLogEntry).time }));
    expect(runs).toHaveLength(3);
    const firstEnd = Math.min(runs[0].end, runs[1].end);
    expect(runs[2].start).toBeGreaterThanOrEqual(firstEnd);
    // Most fakes alive at one instant; the peak always falls on some run's start.
    const peak = Math.max(...runs.map((r) => runs.filter((o) => o.start <= r.start && r.start < o.end).length));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("hang + small timeoutSec: the process is killed, the turn errors with retry, no orphan", async () => {
    const { runner, events } = makeRunner("hang", { timeoutSec: 1 });
    const { t, shot } = await newThread();
    const started = Date.now();
    const outcome = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ ok: false, kind: "timeout" });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "timeout", retry: true });
    const [start] = await fakeEntries();
    expect(alive(start.pid)).toBe(false);
    const saved = await store.getThread(t.id);
    expect(saved.status).toBe("error");
    expect(saved.turns.at(-1)).toMatchObject({ role: "assistant", isError: true, errorKind: "timeout" });
    // SPEC §3.4: the first turn's transcript is adopted when the turn exits, failed or not.
    const owned = path.join(dataDir, "threads", t.id, `${t.sessionId}.jsonl`);
    expect(saved.transcriptPath).toBe(owned);
    expect((await readFile(owned, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await leftInProjects()).toEqual([]);
  });

  it("no-conversation: falls back to a fresh session carrying prior images and earlier answers; new sid stored; card note", async () => {
    const { runner, events } = makeRunner("no-conversation");
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual(OK);
    const first = await store.getThread(t.id);
    const shot2 = await store.saveScreenshot(t.id, Buffer.from("png-2"));
    const outcome = await runner.enqueue(t.id, { kind: "append", screenshot: shot2.file });
    expect(outcome).toEqual(OK);

    const starts = (await fakeEntries()).filter((e) => e.event === "start");
    expect(starts).toHaveLength(3);
    expect(starts[1].argv).toContain("--resume");
    const fallback = starts[2];
    const after = await store.getThread(t.id);
    expect(after.sessionId).not.toBe(first.sessionId);
    expect(fallback.argv?.slice(-2)).toEqual(["--session-id", after.sessionId]);
    const blocks = fallback.stdin?.message.content ?? [];
    expect(blocks.map((b) => b.type)).toEqual(["image", "image", "text"]);
    const text = blocks[2].text as string;
    expect(text).toContain("Earlier answers in this thread:");
    expect(text).toContain("Answer 1: saw 1 image(s).");
    expect(text).toContain("Here is another screenshot. If it is unrelated to the earlier problem, treat it as a new question.");

    expect(after.transcriptPath).toBe(path.join(dataDir, "threads", t.id, `${after.sessionId}.jsonl`));
    const done = events.at(-1) as Extract<RunnerEvent, { type: "done" }>;
    expect(done).toMatchObject({ type: "done", note: "resumeFallback" });
    expect(after.turns.at(-1)).toMatchObject({ role: "assistant", isError: false, note: "resumeFallback" });
    expect(after.turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("a thread whose owned transcript is gone goes straight to the fallback without a failed resume", async () => {
    const { runner, events } = makeRunner("ok");
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual(OK);
    await rm((await store.getThread(t.id)).transcriptPath as string);
    const outcome = await runner.enqueue(t.id, { kind: "followUp", text: "next?" });
    expect(outcome).toEqual(OK);
    const starts = (await fakeEntries()).filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].argv).toContain("--session-id");
    expect(starts[1].argv).not.toContain("--resume");
    expect(events.at(-1)).toMatchObject({ type: "done", note: "resumeFallback" });
  });

  it("missing claudePath → claudeNotFound, and the runner keeps working", async () => {
    let calls = 0;
    const command = () =>
      ++calls === 1 ? { path: path.join(root, "nowhere", "claude.exe"), prefixArgs: [] } : { path: process.execPath, prefixArgs: [FAKE] };
    const { runner, events } = makeRunner("ok", { command, maxConcurrent: 1 });
    const a = await newThread("a");
    const b = await newThread("b");
    const [oa, ob] = await Promise.all([
      runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file }),
      runner.enqueue(b.t.id, { kind: "new", screenshot: b.shot.file }),
    ]);
    expect(oa).toMatchObject({ ok: false, kind: "claudeNotFound" });
    expect(events.find((e) => e.type === "error")).toMatchObject({ threadId: a.t.id, kind: "claudeNotFound", retry: true });
    expect(ob).toEqual(OK);
    expect((await store.getThread(a.t.id)).status).toBe("error");
  });

  it("missing claudePath: Node's spawn error is logged without its argv; nothing to adopt, so no missing mark", async () => {
    const file = path.join(root, "logs", "snapsolve.log");
    const log = createLogger(file);
    const command = { path: path.join(root, "nowhere", "claude.exe"), prefixArgs: [] };
    const { runner } = makeRunner("ok", { command, log });
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toMatchObject({ ok: false, kind: "claudeNotFound" });
    await log.flush();
    const text = await readFile(file, "utf8");
    const failed = text.split("\n").filter((l) => l.includes('"event":"runner.turnFailed"'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('"code":"ENOENT"');
    expect(text).not.toContain("Answer concisely");
    expect(text).not.toContain("--strict-mcp-config");
    expect(text).not.toContain("spawnargs");
    const saved = await store.getThread(t.id);
    expect(saved.transcriptPath).toBeNull();
    expect(saved.transcriptMissing).toBeUndefined();
  });

  it("crash mid-stream (exit 1, no result) → errored turn with retry, partial text kept", async () => {
    const { runner, events } = makeRunner("crash");
    const { t, shot } = await newThread();
    const outcome = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(outcome.ok).toBe(false);
    expect(deltas(events, t.id)).toBe("Answer 1: saw 1");
    expect(events.at(-1)).toMatchObject({ type: "error", threadId: t.id, kind: "internal", retry: true });
    const saved = await store.getThread(t.id);
    expect(saved.status).toBe("error");
    expect(saved.turns.at(-1)).toMatchObject({ role: "assistant", isError: true, text: "Answer 1: saw 1" });
    const owned = path.join(dataDir, "threads", t.id, `${t.sessionId}.jsonl`);
    expect(saved.transcriptPath).toBe(owned);
    expect((await readFile(owned, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await leftInProjects()).toEqual([]);
  });

  it("a fallback turn that crashes still adopts its new session's transcript", async () => {
    const first = makeRunner("ok");
    const { t, shot } = await newThread();
    expect(await first.runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual(OK);
    await rm((await store.getThread(t.id)).transcriptPath as string);

    const { runner } = makeRunner("crash");
    expect(await runner.enqueue(t.id, { kind: "followUp", text: "next?" })).toMatchObject({ ok: false, kind: "internal" });
    const after = await store.getThread(t.id);
    expect(after.sessionId).not.toBe(t.sessionId);
    const owned = path.join(dataDir, "threads", t.id, `${after.sessionId}.jsonl`);
    expect(after.transcriptPath).toBe(owned);
    expect(existsSync(owned)).toBe(true);
    expect(await leftInProjects()).toEqual([]);
  });

  it("not-logged-in and api-key scenarios surface as notLoggedIn and an init warning", async () => {
    const a = makeRunner("not-logged-in");
    const x = await newThread();
    expect(await a.runner.enqueue(x.t.id, { kind: "new", screenshot: x.shot.file })).toMatchObject({ ok: false, kind: "notLoggedIn" });

    const b = makeRunner("api-key");
    const y = await newThread();
    expect(await b.runner.enqueue(y.t.id, { kind: "new", screenshot: y.shot.file })).toEqual(OK);
    expect(b.events.find((e) => e.type === "init")).toMatchObject({ apiKeyWarning: true });
  });

  it("rate-limited → usageLimit with the reset time and Claude's message", async () => {
    const { runner, events } = makeRunner("rate-limited");
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toMatchObject({ ok: false, kind: "usageLimit" });
    expect(events.find((e) => e.type === "rateLimit")).toMatchObject({ status: "rejected", resetsAt: 1791996600 });
    expect(events.at(-1)).toMatchObject({ kind: "usageLimit", message: "Claude usage limit reached. Your limit resets at 6pm." });
  });
});
