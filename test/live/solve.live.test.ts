// Live: the real `claude` solves the problem screenshots in test/fixtures/problems/ through the real runner with
// prompts/system.md (SPEC §3.1, §3.7). Consumes plan usage: `npm run test:live` only, never part of `npm test`.
//   SNAPSOLVE_LIVE_MODEL   model for every fixture (default opus; effort is always high)
//   SNAPSOLVE_LIVE_REPORT  file that gets one JSON line per fixture (answer, timings, checks) for docs/live-results.md
//   SNAPSOLVE_CLAUDE       path of the claude executable (default: claude.exe or claude on PATH, then ~/.local/bin)
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "../../src/main/log";
import { createRunner, type Runner, type RunnerEvent } from "../../src/main/runner";
import { createStore, type Store } from "../../src/main/store";
import { fixturesDir, repoRoot } from "../paths";

interface Fixture {
  name: string;
  file: string;
  problem: string;
  accepts: string;
  /** Must match the first non-empty line of the answer. */
  answer: string;
  flags?: string;
  /** A fenced block in `language` without `absent` and matching `present`. */
  fix?: { language: string; absent: string; present: string };
}

const MODEL = process.env.SNAPSOLVE_LIVE_MODEL || "opus";
const EFFORT = "high";
const REPORT = process.env.SNAPSOLVE_LIVE_REPORT;
const MAX_MS = 60_000;
const MAX_LINES = 25;
const PREAMBLE = /^(sure|certainly|of course|okay|ok\b|great|let's|let us|let me|here's|here is|i'll|i will|to solve|looking at)/i;
const RAW_HTML = /<\/?(img|div|span|p|br|a|b|i|u|sup|sub|table|tr|td|script|iframe|svg|math|style)\b[^>]*>/i;

const problems = path.join(fixturesDir, "problems");
const { fixtures } = JSON.parse(readFileSync(path.join(problems, "expected.json"), "utf8")) as { fixtures: Fixture[] };
const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };

let root: string | undefined;
let sessionsDir: string | undefined;
let store: Store;
let runner: Runner;
const events: RunnerEvent[] = [];

function findClaude(): string {
  if (process.env.SNAPSOLVE_CLAUDE) return process.env.SNAPSOLVE_CLAUDE;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(os.homedir(), ".local", "bin")];
  for (const name of ["claude.exe", "claude"]) {
    for (const dir of dirs) {
      if (existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  throw new Error("claude not found on PATH or in ~/.local/bin; set SNAPSOLVE_CLAUDE");
}

/** The answer without fenced blocks and inline code spans. */
function prose(answer: string): string {
  return answer.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "");
}

function fencedBlocks(answer: string): { language: string; code: string }[] {
  return [...answer.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ language: m[1].toLowerCase(), code: m[2] }));
}

function check(fx: Fixture, answer: string) {
  const lines = answer.trim().split("\n");
  const first = lines.find((l) => l.trim() !== "") ?? "";
  const bare = first.replace(/^[\s#>*_-]+/, "");
  return {
    answerFirst: new RegExp(fx.answer, fx.flags ?? "").test(first),
    noPreamble: !PREAMBLE.test(bare),
    short: lines.length < MAX_LINES,
    noHtml: !RAW_HTML.test(prose(answer)),
    fix:
      !fx.fix ||
      fencedBlocks(answer).some(
        (b) =>
          b.language === fx.fix?.language && !b.code.includes(fx.fix.absent) && new RegExp(fx.fix.present).test(b.code),
      ),
  };
}

beforeAll(async () => {
  const systemPrompt = await readFile(path.join(repoRoot, "prompts", "system.md"), "utf8");
  root = await mkdtemp(path.join(os.tmpdir(), "snapsolve-live-"));
  const dataDir = path.join(root, "data");
  sessionsDir = path.join(dataDir, "sessions");
  store = createStore({ dataDir, projectsDir, purge: async () => {}, log: quietLog });
  runner = createRunner({
    command: { path: findClaude(), prefixArgs: [] },
    store,
    config: { maxConcurrent: 1, timeoutSec: 120, allowApiKey: false },
    systemPrompt,
    env: process.env,
    spawn,
    sessionsDir,
    log: quietLog,
    loadSendImage: async (file) => ({ mediaType: "image/png", data: (await readFile(file)).toString("base64") }),
  });
  runner.on((e) => events.push(e));
});

afterAll(async () => {
  // claude made a project dir for the sessions cwd; every transcript was adopted, so it is empty now.
  if (sessionsDir) await rmdir(path.join(projectsDir, sessionsDir.replace(/[^A-Za-z0-9]/g, "-"))).catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe(`live solve with prompts/system.md (${MODEL}/${EFFORT})`, () => {
  for (const fx of fixtures) {
    it(`${fx.name}: ${fx.accepts}`, async () => {
      const thread = await store.createThread({ model: MODEL, effort: EFFORT });
      const shot = await store.saveScreenshot(thread.id, await readFile(path.join(problems, fx.file)));
      const started = Date.now();
      const outcome = await runner.enqueue(thread.id, { kind: "new", screenshot: shot.file });
      const ms = Date.now() - started;
      const done = events.find((e): e is Extract<RunnerEvent, { type: "done" }> => e.type === "done" && e.threadId === thread.id);
      const answer = done?.turn.text ?? "";
      const checks = check(fx, answer);
      if (REPORT) {
        const { ttftMs = null, durationMs = null, costUsd = null } = done?.turn ?? {};
        const line = { model: MODEL, effort: EFFORT, name: fx.name, ok: outcome.ok, ms, ttftMs, durationMs, costUsd, checks, answer };
        await appendFile(REPORT, `${JSON.stringify(line)}\n`);
      }

      expect(outcome, JSON.stringify(outcome)).toEqual({ ok: true, thread: expect.anything() });
      expect(done?.turn.isError).toBe(false);
      expect(ms, "turn time").toBeLessThan(MAX_MS);
      expect(checks, answer).toEqual({ answerFirst: true, noPreamble: true, short: true, noHtml: true, fix: true });
      const saved = await store.getThread(thread.id);
      expect(saved.transcriptPath, "transcript adopted").toBe(path.join(root as string, "data", "threads", thread.id, `${saved.sessionId}.jsonl`));
    });
  }
});
