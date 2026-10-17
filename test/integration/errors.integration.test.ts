import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/main/app";
import { checkAuth } from "../../src/main/auth";
import type { Logger } from "../../src/main/log";
import { createRunner, type Command, type RunnerEvent } from "../../src/main/runner";
import { createStore, type Store } from "../../src/main/store";
import { userMessage } from "../../src/shared/errors";
import type { AssistantTurn, Thread } from "../../src/shared/types";
import { fixturesDir } from "../paths";

const FAKE = path.join(fixturesDir, "fake-claude.mjs");
const COMMAND: Command = { path: process.execPath, prefixArgs: [FAKE] };
const PNG = path.join(fixturesDir, "problems", "algebra.png");
/** The fake's rate_limit_event resetsAt (unix seconds). */
const FAKE_RESET = 1_791_996_600;
const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };

interface FakeLogEntry {
  event: "start" | "end" | "auth";
}

let root: string;
let dataDir: string;
let projects: string;
let fakeLog: string;
let store: Store;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "snapsolve-errors-int-")));
  dataDir = path.join(root, "data");
  projects = path.join(root, "projects");
  fakeLog = path.join(root, "fake.log");
  store = createStore({ dataDir, projectsDir: projects, purge: async () => {}, log: quietLog });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function fakeEnv(scenario: string, extra: Record<string, string> = {}) {
  return { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_PROJECTS: projects, FAKE_LOG: fakeLog, ...extra };
}

function makeRunner(scenario: string, options: { allowApiKey?: boolean; now?: () => number; env?: Record<string, string> } = {}) {
  const env = fakeEnv(scenario, options.env);
  const runner = createRunner({
    command: COMMAND,
    store,
    config: { maxConcurrent: 2, timeoutSec: 30, allowApiKey: options.allowApiKey ?? false },
    systemPrompt: "You are snapsolve.",
    env,
    spawn,
    sessionsDir: path.join(dataDir, "sessions"),
    log: quietLog,
    now: options.now,
    loadSendImage: async (file) => ({ mediaType: "image/png", data: (await readFile(file)).toString("base64") }),
    checkAuth: () => checkAuth({ execFile: promisify(execFile), command: COMMAND, env, log: quietLog }),
  });
  const events: RunnerEvent[] = [];
  runner.on((e) => events.push(e));
  return { runner, events };
}

async function newThread(): Promise<{ thread: Thread; file: string }> {
  const thread = await store.createThread({ model: "claude-opus-5-5", effort: "high" });
  const saved = await store.saveScreenshot(thread.id, await readFile(PNG));
  return { thread, file: saved.file };
}

async function fakeEntries(): Promise<FakeLogEntry[]> {
  if (!existsSync(fakeLog)) return [];
  return (await readFile(fakeLog, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FakeLogEntry);
}

const count = async (event: FakeLogEntry["event"]) => (await fakeEntries()).filter((e) => e.event === event).length;

async function lastAnswer(threadId: string): Promise<AssistantTurn> {
  const turn = (await store.getThread(threadId)).turns.at(-1);
  if (turn?.role !== "assistant") throw new Error(`last turn of ${threadId} is not an answer`);
  return turn;
}

describe("auth errors (fake claude)", () => {
  it("not-logged-in → error kind notLoggedIn with the log-in message on the card", async () => {
    const { runner, events } = makeRunner("not-logged-in");
    const { thread, file } = await newThread();
    const outcome = await runner.enqueue(thread.id, { kind: "new", screenshot: file });
    expect(outcome).toEqual({ ok: false, kind: "notLoggedIn", message: userMessage("notLoggedIn") });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "notLoggedIn", message: "Run `claude` once and log in." });
    expect(await lastAnswer(thread.id)).toMatchObject({ isError: true, errorKind: "notLoggedIn" });
  });

  it("an error result rechecks `claude auth status`: logged out → notLoggedIn", async () => {
    const { runner } = makeRunner("error", { env: { FAKE_AUTH: "logged-out" } });
    const { thread, file } = await newThread();
    const outcome = await runner.enqueue(thread.id, { kind: "new", screenshot: file });
    expect(outcome).toMatchObject({ ok: false, kind: "notLoggedIn" });
    expect(await count("auth")).toBe(1);
    expect(await lastAnswer(thread.id)).toMatchObject({ errorKind: "notLoggedIn", errorMessage: userMessage("notLoggedIn") });
  });

  it("an error result while still logged in keeps its own kind (one auth recheck)", async () => {
    const { runner } = makeRunner("error");
    const { thread, file } = await newThread();
    const outcome = await runner.enqueue(thread.id, { kind: "new", screenshot: file });
    expect(outcome).toMatchObject({ ok: false, kind: "internal" });
    expect(await count("auth")).toBe(1);
  });

  it("an unreadable auth status keeps the turn's own kind", async () => {
    const { runner } = makeRunner("error", { env: { FAKE_AUTH: "malformed" } });
    const { thread, file } = await newThread();
    expect(await runner.enqueue(thread.id, { kind: "new", screenshot: file })).toMatchObject({ ok: false, kind: "internal" });
  });

  it("a successful turn does not run auth status", async () => {
    const { runner } = makeRunner("ok");
    const { thread, file } = await newThread();
    expect(await runner.enqueue(thread.id, { kind: "new", screenshot: file })).toMatchObject({ ok: true });
    expect(await count("auth")).toBe(0);
  });
});

describe("API key warning (fake claude)", () => {
  it("api-key init source → init event with the warning, and the saved answer carries it", async () => {
    const { runner, events } = makeRunner("api-key");
    const { thread, file } = await newThread();
    expect(await runner.enqueue(thread.id, { kind: "new", screenshot: file })).toMatchObject({ ok: true });
    expect(events.find((e) => e.type === "init")).toMatchObject({ apiKeySource: "ANTHROPIC_API_KEY", apiKeyWarning: true });
    expect(await lastAnswer(thread.id)).toMatchObject({ isError: false, warning: "apiKeyInUse" });
  });

  it("no warning when allowApiKey is true or the source is the claude.ai login", async () => {
    for (const [scenario, allowApiKey] of [
      ["api-key", true],
      ["ok", false],
    ] as const) {
      const { runner, events } = makeRunner(scenario, { allowApiKey });
      const { thread, file } = await newThread();
      expect(await runner.enqueue(thread.id, { kind: "new", screenshot: file })).toMatchObject({ ok: true });
      expect(events.find((e) => e.type === "init")).toMatchObject({ apiKeyWarning: false });
      expect(await lastAnswer(thread.id)).not.toHaveProperty("warning");
    }
  });
});

describe("usage (fake claude)", () => {
  it("a successful answer carries the usage line for the card footer", async () => {
    const { runner } = makeRunner("ok");
    const { thread, file } = await newThread();
    expect(await runner.enqueue(thread.id, { kind: "new", screenshot: file })).toMatchObject({ ok: true });
    expect(await lastAnswer(thread.id)).toMatchObject({ usage: "5h 12% · 7d 34%" });
  });

  it("rate-limited → usageLimit with Claude's words, then blocked: no further spawn until the reset", async () => {
    let clock = FAKE_RESET * 1000 - 3_600_000;
    const scenario = path.join(root, "scenario");
    const { runner, events } = makeRunner("ok", { now: () => clock, env: { FAKE_CLAUDE_SCENARIO_FILE: scenario } });
    await writeFile(scenario, "rate-limited");

    const first = await newThread();
    const outcome = await runner.enqueue(first.thread.id, { kind: "new", screenshot: first.file });
    expect(outcome).toMatchObject({ ok: false, kind: "usageLimit", message: "Claude usage limit reached. Your limit resets at 6pm." });
    expect(await count("start")).toBe(1);

    // Blocked before spawning: the card names the reset time, claude is not started.
    await writeFile(scenario, "ok");
    const second = await newThread();
    const blocked = await runner.enqueue(second.thread.id, { kind: "new", screenshot: second.file });
    expect(blocked).toMatchObject({ ok: false, kind: "usageLimit" });
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.message).toMatch(/^Usage limit reached\. Resets at .+\.$/);
    expect(await count("start")).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", threadId: second.thread.id, kind: "usageLimit", retry: true });
    const saved = await store.getThread(second.thread.id);
    expect(saved.status).toBe("error");
    expect(saved.turns.at(-1)).toMatchObject({ role: "assistant", isError: true, errorKind: "usageLimit", errorMessage: blocked.message });

    // A follow-up is blocked the same way.
    expect(await runner.enqueue(first.thread.id, { kind: "followUp", text: "and now?" })).toMatchObject({ ok: false, kind: "usageLimit" });
    expect(await count("start")).toBe(1);

    // After the reset time, turns spawn again.
    clock = FAKE_RESET * 1000 + 1000;
    const third = await newThread();
    expect(await runner.enqueue(third.thread.id, { kind: "new", screenshot: third.file })).toMatchObject({ ok: true });
    expect(await count("start")).toBe(2);
  });
});

describe("app wiring (fake claude)", () => {
  it("usage from every rate_limit_event reaches onUsage (the tray tooltip)", async () => {
    const { runner } = makeRunner("ok");
    const onUsage = vi.fn();
    const app = createApp({
      store,
      runner,
      panel: { open() {}, send() {} },
      config: { model: "claude-opus-5-5", effort: "high", maxScreenshotsPerThread: 6 },
      log: quietLog,
      clipboard: { writeText() {} },
      openExternal: async () => {},
      confirmClearHistory: async () => false,
      onUsage,
    });
    const done = new Promise<void>((resolve) => runner.on((e) => e.type === "done" && resolve()));
    await app.onCapture({ png: await readFile(PNG) });
    await done;
    expect(onUsage).toHaveBeenLastCalledWith("5h 12% · 7d 34%");
  });
});
