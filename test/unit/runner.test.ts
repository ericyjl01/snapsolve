import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../../src/main/log";
import {
  buildArgs,
  buildEnv,
  buildFallbackMessage,
  buildUserMessage,
  createRunner,
  APPEND_TEXT,
  NEW_TEXT,
  type RunnerEvent,
  SEED_HEADER,
  seededQuestion,
  type SendImage,
  type TurnRequest,
  withLoginShellPath,
} from "../../src/main/runner";
import { createStore, type Store } from "../../src/main/store";
import { userMessage } from "../../src/shared/errors";
import type { Thread } from "../../src/shared/types";

const SID = "0b8f6a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b";
const PROMPT = 'You are snapsolve.\nUse "Markdown" & $math$; never <html>.';
const PNG: SendImage = { mediaType: "image/png", data: "iVBORw0KGgo=" };
const JPEG: SendImage = { mediaType: "image/jpeg", data: "/9j/4AAQ" };

const SPEC_FLAGS = [
  "-p",
  "--safe-mode",
  "--strict-mcp-config",
  "--tools",
  "",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model",
  "opus",
  "--effort",
  "high",
  "--system-prompt",
  PROMPT,
];

describe("buildArgs", () => {
  it("first turn: exactly the SPEC §3.1 flags plus --session-id, no --resume", () => {
    const args = buildArgs({ model: "opus", effort: "high", systemPrompt: PROMPT, session: { id: SID } });
    expect(args).toEqual([...SPEC_FLAGS, "--session-id", SID]);
    expect(args).not.toContain("--resume");
  });

  it("the system prompt is one argv element, verbatim", () => {
    const args = buildArgs({ model: "opus", effort: "high", systemPrompt: PROMPT, session: { id: SID } });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(PROMPT);
    expect(args.filter((a) => a.includes("snapsolve"))).toEqual([PROMPT]);
  });

  it("later turn: --resume <absolute transcript path>, no --session-id", () => {
    const transcript = path.resolve(os.tmpdir(), "threads", "t", `${SID}.jsonl`);
    const args = buildArgs({ model: "sonnet", effort: "low", systemPrompt: PROMPT, session: { resume: transcript } });
    expect(args.slice(-2)).toEqual(["--resume", transcript]);
    expect(args).not.toContain("--session-id");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });

  it("refuses a relative resume path", () => {
    expect(() => buildArgs({ model: "opus", effort: "high", systemPrompt: PROMPT, session: { resume: "t/x.jsonl" } })).toThrow();
  });

  it("never --bare, --setting-sources or --system-prompt-file", () => {
    for (const session of [{ id: SID }, { resume: path.resolve("x.jsonl") }]) {
      const args = buildArgs({ model: "opus", effort: "high", systemPrompt: PROMPT, session });
      for (const banned of ["--bare", "--setting-sources", "--system-prompt-file", "--append-system-prompt"]) {
        expect(args).not.toContain(banned);
      }
    }
  });
});

describe("buildEnv", () => {
  const base = {
    PATH: "C:\\bin;C:\\tools",
    HOME: "C:\\Users\\u",
    CLAUDECODE: "1",
    CLAUDECODE_FOO: "x",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    ANTHROPIC_AUTH_TOKEN: "tok",
    UNSET: undefined,
  };

  it("strips CLAUDECODE*, CLAUDE_CODE_ENTRYPOINT and the API key vars; keeps PATH", () => {
    const env = buildEnv(base, false);
    expect(env).toEqual({ PATH: "C:\\bin;C:\\tools", HOME: "C:\\Users\\u" });
  });

  it("keeps the API vars when allowApiKey", () => {
    const env = buildEnv(base, true);
    expect(env).toEqual({
      PATH: "C:\\bin;C:\\tools",
      HOME: "C:\\Users\\u",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_AUTH_TOKEN: "tok",
    });
  });

  it("does not modify its input", () => {
    const copy = { ...base };
    buildEnv(copy, false);
    expect(copy).toEqual(base);
  });
});

describe("buildUserMessage", () => {
  const content = (m: ReturnType<typeof buildUserMessage>) => m.message.content;

  it("new: the image, then 'Solve the problem on this screen.'", () => {
    const m = buildUserMessage("new", [PNG]);
    expect(m).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
          { type: "text", text: "Solve the problem on this screen." },
        ],
      },
    });
  });

  it("follow-up: the text only", () => {
    expect(content(buildUserMessage("followUp", [], "Why divide by 2?"))).toEqual([{ type: "text", text: "Why divide by 2?" }]);
  });

  it("append: the image, then 'Here is the next part.'; the media type is preserved", () => {
    expect(content(buildUserMessage("append", [JPEG]))).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.data } },
      { type: "text", text: "Here is the next part." },
    ]);
  });

  it("serializes to one line", () => {
    expect(JSON.stringify(buildUserMessage("followUp", [], "line 1\nline 2"))).not.toContain("\n");
  });

  it("fallback: every prior screenshot, the earlier answers, then the new question", () => {
    const m = buildFallbackMessage([PNG, JPEG], ["x = 4", "Because 2x = 8."], "And if it were 2x + 5?");
    const blocks = m.message.content;
    expect(blocks.slice(0, 2)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.data } },
    ]);
    expect(blocks).toHaveLength(3);
    const text = (blocks[2] as { text: string }).text;
    expect(text.startsWith("Earlier answers in this thread:")).toBe(true);
    expect(text.indexOf("x = 4")).toBeLessThan(text.indexOf("Because 2x = 8."));
    expect(text.trimEnd().endsWith("And if it were 2x + 5?")).toBe(true);
  });

  it("fallback with no earlier answers is just the screenshots and the question", () => {
    const blocks = buildFallbackMessage([PNG], [], "Solve the problem on this screen.").message.content;
    expect(blocks[1]).toEqual({ type: "text", text: "Solve the problem on this screen." });
  });
});

// ── runner against a scripted child process ──────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** Node leaves `pid` undefined when the process could not be started. */
  pid: number | undefined = 4242;
  killed = false;
  written = "";
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => (this.written += d.toString()));
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
  /** Prints the lines, then exits. */
  script(lines: unknown[], code = 0): void {
    setImmediate(() => {
      for (const l of lines) this.stdout.write(`${typeof l === "string" ? l : JSON.stringify(l)}\n`);
      this.stdout.end();
      this.stderr.end();
      setImmediate(() => this.emit("close", code, null));
    });
  }
}

interface SpawnCall {
  file: string;
  args: string[];
  options: { cwd: string; env: Record<string, string>; windowsHide: boolean; stdio: unknown };
  sessionsDirExisted: boolean;
  child: FakeChild;
}

let root: string;
let store: Store;
let sessionsDir: string;
let calls: SpawnCall[];
let script: (child: FakeChild, call: SpawnCall) => void;
const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snapsolve-runner-unit-"));
  store = createStore({ dataDir: path.join(root, "data"), projectsDir: path.join(root, "projects"), purge: async () => {}, log: quietLog });
  sessionsDir = path.join(root, "data", "sessions");
  calls = [];
  script = (child, call) => child.script(okLines(call));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function okLines(call: SpawnCall, text = "x = 4"): unknown[] {
  const sid = call.args[call.args.indexOf("--session-id") + 1];
  return [
    { type: "system", subtype: "init", session_id: sid, apiKeySource: "none", model: "claude-opus-5-5" },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 9 },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, 2) } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(2) } } },
    { type: "assistant", message: { content: [{ type: "text", text }] } },
    { type: "result", subtype: "success", is_error: false, result: text, duration_ms: 900, duration_api_ms: 800, ttft_ms: 200, total_cost_usd: 0.01 },
  ];
}

function makeRunner(over: Partial<Parameters<typeof createRunner>[0]> = {}) {
  const runner = createRunner({
    command: { path: "C:\\fake\\claude.exe", prefixArgs: ["--prefix"] },
    store,
    config: { maxConcurrent: 2, timeoutSec: 30, allowApiKey: false },
    systemPrompt: PROMPT,
    env: { PATH: "C:\\bin", CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk" },
    spawn: ((file: string, args: string[], options: SpawnCall["options"]) => {
      const child = new FakeChild();
      const call = { file, args, options, sessionsDirExisted: existsSync(options.cwd), child };
      calls.push(call);
      script(child, call);
      return child;
    }) as never,
    sessionsDir,
    log: quietLog,
    loadSendImage: async () => PNG,
    ...over,
  });
  const events: RunnerEvent[] = [];
  runner.on((e) => events.push(e));
  return { runner, events };
}

async function newThread() {
  const t = await store.createThread({ model: "opus", effort: "high" });
  const shot = await store.saveScreenshot(t.id, Buffer.from("png"));
  return { t, shot };
}

describe("runner spawn", () => {
  it("spawns the command with windowsHide, cwd = sessions dir created before spawn, stripped env, prefix args first", async () => {
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    expect(existsSync(sessionsDir)).toBe(false);
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.file).toBe("C:\\fake\\claude.exe");
    expect(c.args[0]).toBe("--prefix");
    expect(c.args.slice(1)).toEqual(buildArgs({ model: "opus", effort: "high", systemPrompt: PROMPT, session: { id: t.sessionId } }));
    expect(c.options.windowsHide).toBe(true);
    expect(c.options.cwd).toBe(sessionsDir);
    expect(c.sessionsDirExisted).toBe(true);
    expect(c.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(c.options.env).toEqual({ PATH: "C:\\bin" });
  });

  it("writes exactly one stream-json line to stdin and closes it", async () => {
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    const written = calls[0].child.written;
    expect(written.endsWith("\n")).toBe(true);
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(written)).toEqual(buildUserMessage("new", [PNG]));
    expect(calls[0].child.stdin.writableEnded).toBe(true);
  });

  it("emits status, one thinking, deltas in order, init and done; records the user and assistant turns", async () => {
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    const outcome = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(outcome.ok).toBe(true);
    const types = events.map((e) => e.type);
    expect(types.filter((x) => x === "thinking")).toHaveLength(1);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text)).toEqual(["x ", "= 4"]);
    expect(types.indexOf("status")).toBeLessThan(types.indexOf("delta"));
    expect(types.at(-1)).toBe("done");
    expect(events.find((e) => e.type === "init")).toMatchObject({ threadId: t.id, apiKeySource: "none", apiKeyWarning: false });
    const done = events.at(-1) as Extract<RunnerEvent, { type: "done" }>;
    expect(done.turn).toEqual({ role: "assistant", text: "x = 4", durationMs: 900, ttftMs: 200, costUsd: 0.01, isError: false });
    const saved = await store.getThread(t.id);
    expect(saved.turns).toEqual([{ role: "user", kind: "screenshot", file: "001.png" }, done.turn]);
    expect(saved.status).toBe("done");
  });

  it("an API key source other than the login while allowApiKey is false → init carries the warning", async () => {
    script = (child, call) => {
      const lines = okLines(call);
      (lines[0] as { apiKeySource: string }).apiKeySource = "ANTHROPIC_API_KEY";
      child.script(lines);
    };
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(events.find((e) => e.type === "init")).toMatchObject({ apiKeySource: "ANTHROPIC_API_KEY", apiKeyWarning: true });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("a rejected rate limit with an error result → usageLimit with Claude's message verbatim", async () => {
    script = (child) =>
      child.script(
        [
          { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791996600 } },
          { type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Resets 6pm." },
        ],
        1,
      );
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    const outcome = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(outcome.ok).toBe(false);
    expect(events.find((e) => e.type === "rateLimit")).toMatchObject({ status: "rejected", resetsAt: 1791996600 });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "usageLimit", message: "Claude usage limit reached. Resets 6pm.", retry: true });
    expect((await store.getThread(t.id)).turns.at(-1)).toMatchObject({
      role: "assistant",
      isError: true,
      errorKind: "usageLimit",
      errorMessage: "Claude usage limit reached. Resets 6pm.",
    });
  });

  it("an error result saying not logged in → notLoggedIn", async () => {
    script = (child) => child.script([{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }], 1);
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "notLoggedIn" });
  });

  it("spawn ENOENT → claudeNotFound; a spawn that throws → internal; neither blocks the next turn", async () => {
    let n = 0;
    const { runner, events } = makeRunner({
      config: { maxConcurrent: 1, timeoutSec: 30, allowApiKey: false },
      spawn: ((file: string, args: string[], options: SpawnCall["options"]) => {
        n++;
        if (n === 2) throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
        const child = new FakeChild();
        const call = { file, args, options, sessionsDirExisted: true, child };
        calls.push(call);
        if (n === 1) setImmediate(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })));
        else child.script(okLines(call));
        return child;
      }) as never,
    });
    const a = await newThread();
    const b = await newThread();
    const c = await newThread();
    const outcomes = await Promise.all([
      runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file }),
      runner.enqueue(b.t.id, { kind: "new", screenshot: b.shot.file }),
      runner.enqueue(c.t.id, { kind: "new", screenshot: c.shot.file }),
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([false, false, true]);
    expect(events.filter((e) => e.type === "error").map((e) => (e as { kind: string }).kind)).toEqual(["claudeNotFound", "internal"]);
  });

  it("an unknown thread → error threadNotFound without spawning", async () => {
    const { runner, events } = makeRunner();
    const outcome = await runner.enqueue("6f1c2d3e-4a5b-4c6d-8e7f-001122334455", { kind: "followUp", text: "hi" });
    expect(outcome).toMatchObject({ ok: false, kind: "threadNotFound" });
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "threadNotFound", retry: false });
  });

  it("an empty follow-up is refused without spawning", async () => {
    const { runner } = makeRunner();
    const { t } = await newThread();
    await expect(runner.enqueue(t.id, { kind: "followUp", text: "  " })).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe("failed turns: details go to the log, the card gets the fixed message", () => {
  const INTERNAL = userMessage("internal");
  const ANSWER = "SECRET-PARTIAL-ANSWER";

  async function loggedRunner(over: Partial<Parameters<typeof createRunner>[0]> = {}) {
    const file = path.join(root, "data", "logs", "snapsolve.log");
    const log = createLogger(file);
    const made = makeRunner({ log, ...over });
    const read = async () => {
      await log.flush();
      return readFile(file, "utf8");
    };
    return { ...made, read };
  }

  it("a crash (exit 1, no result): its stderr is in the runner.turnFailed log line, the answer text is not; card = internal text", async () => {
    script = (child) => {
      child.stderr.write("panic: socket closed at frame 7\n");
      child.script([{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ANSWER } } }], 1);
    };
    const { runner, events, read } = await loggedRunner();
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual({ ok: false, kind: "internal", message: INTERNAL });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "internal", message: INTERNAL, retry: true });
    expect((await store.getThread(t.id)).turns.at(-1)).toMatchObject({ isError: true, errorKind: "internal", errorMessage: INTERNAL, text: ANSWER });

    const text = await read();
    const failed = text.split("\n").filter((l) => l.includes('"event":"runner.turnFailed"'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("panic: socket closed at frame 7");
    expect(failed[0]).toContain("code 1");
    expect(text).not.toContain(ANSWER);
  });

  it("an exception inside the turn: its message and stack are in the runner.turnFailed log line; card = internal text", async () => {
    const { runner, events, read } = await loggedRunner({
      loadSendImage: async () => {
        throw new TypeError("cannot decode 001.png: bad zlib header");
      },
    });
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual({ ok: false, kind: "internal", message: INTERNAL });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "internal", message: INTERNAL });
    expect(calls).toHaveLength(0);

    const failed = (await read()).split("\n").filter((l) => l.includes('"event":"runner.turnFailed"'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("cannot decode 001.png: bad zlib header");
    expect(failed[0]).toContain("TypeError");
    expect(JSON.parse(failed[0])).toMatchObject({ level: "warn", threadId: t.id, kind: "internal" });
  });

  it("a spawn error: its code, syscall and path are logged, never its spawnargs (the argv with the system prompt)", async () => {
    const SYSTEM = "SECRET-SYSTEM-PROMPT: work the problem fully";
    let n = 0;
    const { runner, read } = await loggedRunner({
      systemPrompt: SYSTEM,
      config: { maxConcurrent: 1, timeoutSec: 30, allowApiKey: false },
      spawn: ((file: string, args: string[]) => {
        // Shaped like Node's spawn errors, which carry the whole argv as `spawnargs`.
        const spawnError = (code: string) =>
          Object.assign(new Error(`spawn ${file} ${code}`), { errno: -4058, code, syscall: `spawn ${file}`, path: file, spawnargs: args });
        if (++n === 2) throw spawnError("EACCES");
        const child = new FakeChild();
        child.pid = undefined;
        setImmediate(() => child.emit("error", spawnError("ENOENT")));
        return child;
      }) as never,
    });
    const a = await newThread();
    const b = await newThread();
    expect(await runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file })).toMatchObject({ ok: false, kind: "claudeNotFound" });
    expect(await runner.enqueue(b.t.id, { kind: "new", screenshot: b.shot.file })).toMatchObject({ ok: false, kind: "internal" });

    const text = await read();
    expect(text).not.toContain("SECRET-SYSTEM-PROMPT");
    expect(text).not.toContain("spawnargs");
    expect(text).not.toContain("--strict-mcp-config");
    const failed = text.split("\n").filter((l) => l.includes('"event":"runner.turnFailed"'));
    expect(failed).toHaveLength(2);
    for (const [line, code] of [
      [failed[0], "ENOENT"],
      [failed[1], "EACCES"],
    ]) {
      expect(line).toContain(`"code":"${code}"`);
      expect(line).toContain('"syscall":"spawn C:\\\\fake\\\\claude.exe"');
      expect(line).toContain('"path":"C:\\\\fake\\\\claude.exe"');
      expect(line).toContain(`spawn C:\\\\fake\\\\claude.exe ${code}`);
    }
  });

  // Task 047: a turn that streamed an answer and then ended is_error carries that answer as `result`.
  const streamed = (text: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
  });

  it("answer streamed, then an error result whose text is the answer → the answer is not logged; turnFailed names its length; card = internal", async () => {
    script = (child) =>
      child.script([streamed(ANSWER), { type: "result", subtype: "success", is_error: true, result: ANSWER }], 0);
    const { runner, events, read } = await loggedRunner();
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toEqual({ ok: false, kind: "internal", message: INTERNAL });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "internal", message: INTERNAL });

    const text = await read();
    expect(text).not.toContain(ANSWER);
    const failed = text.split("\n").filter((l) => l.includes('"event":"runner.turnFailed"'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`result: ${ANSWER.length} chars omitted`);
  });

  it("answer streamed, then an error result with errors: [\"overloaded\"] → the log has \"overloaded\", not the answer", async () => {
    script = (child) =>
      child.script([streamed(ANSWER), { type: "result", subtype: "success", is_error: true, result: ANSWER, errors: ["overloaded"] }], 0);
    const { runner, read } = await loggedRunner();
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).toMatchObject({ ok: false, kind: "internal" });
    const text = await read();
    expect(text).not.toContain(ANSWER);
    const failed = text.split("\n").filter((l) => l.includes('"event":"runner.turnFailed"'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("overloaded");
  });

  it("answer streamed, then a usage-limit error result → still usageLimit; neither the log nor the card has the answer", async () => {
    const said = `${ANSWER}\n\nClaude usage limit reached. Resets 6pm.`;
    script = (child) => child.script([streamed(ANSWER), { type: "result", subtype: "success", is_error: true, result: said }], 0);
    const { runner, events, read } = await loggedRunner();
    const { t, shot } = await newThread();
    const r = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(r).toMatchObject({ ok: false, kind: "usageLimit" });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "usageLimit" });
    expect(JSON.stringify(r)).not.toContain(ANSWER);
    // The event's thread keeps the streamed partial answer as the turn text (shown on the card); the error must not.
    expect((events.at(-1) as { message: string }).message).not.toContain(ANSWER);
    expect((await store.getThread(t.id)).turns.at(-1)?.errorMessage ?? "").not.toContain(ANSWER);
    expect(await read()).not.toContain(ANSWER);
  });

  it("notLoggedIn: Claude's text is logged, the card shows the fixed notLoggedIn text", async () => {
    script = (child) => child.script([{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }], 1);
    const { runner, events, read } = await loggedRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "notLoggedIn", message: userMessage("notLoggedIn") });
    expect(await read()).toContain("Not logged in · Please run /login");
  });
});

// ── timeout escalation (018) ─────────────────────────────────────────────────────────────────────────

/** Never prints; records every kill signal; closes `exitAfter(signal)` ms after a kill, or never when null. */
class HangingChild extends FakeChild {
  signals: string[] = [];
  constructor(private readonly exitAfter: (signal: string) => number | null) {
    super();
  }
  override kill(signal?: string): boolean {
    const s = signal ?? "SIGTERM";
    this.signals.push(s);
    const delay = this.exitAfter(s);
    if (delay !== null) setTimeout(() => this.emit("close", null, s), delay);
    return true;
  }
}

describe("timeout escalation: a timed-out claude never outlives its turn", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** First spawn → `first`; later spawns answer normally. timeoutSec 0.05 → the turn times out after 50 ms. */
  function runnerWith(first: HangingChild, killGraceMs: number) {
    let n = 0;
    return makeRunner({
      config: { maxConcurrent: 1, timeoutSec: 0.05, allowApiKey: false },
      killGraceMs,
      spawn: ((file: string, args: string[], options: SpawnCall["options"]) => {
        if (n++ === 0) return first;
        const child = new FakeChild();
        const call = { file, args, options, sessionsDirExisted: true, child };
        calls.push(call);
        child.script(okLines(call));
        return child;
      }) as never,
    });
  }

  const errorsFor = (events: RunnerEvent[], threadId: string) =>
    events.filter((e) => e.type === "error" && (e as { threadId?: string }).threadId === threadId);

  it("a child that ignores the first kill gets SIGKILL after the grace period; the turn errors timeout with retry; the queue moves on", async () => {
    const stubborn = new HangingChild((s) => (s === "SIGKILL" ? 0 : null));
    const { runner, events } = runnerWith(stubborn, 100);
    const a = await newThread();
    const b = await newThread();
    const [oa, ob] = await Promise.all([
      runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file }),
      runner.enqueue(b.t.id, { kind: "new", screenshot: b.shot.file }),
    ]);
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(oa).toMatchObject({ ok: false, kind: "timeout" });
    expect(errorsFor(events, a.t.id)).toEqual([expect.objectContaining({ kind: "timeout", retry: true })]);
    expect(ob.ok).toBe(true);
  });

  it("a child that exits on the first kill gets no SIGKILL, even after the grace period has passed", async () => {
    const polite = new HangingChild(() => 0);
    const { runner, events } = runnerWith(polite, 100);
    const a = await newThread();
    const outcome = await runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file });
    await sleep(250);
    expect(polite.signals).toEqual(["SIGTERM"]);
    expect(outcome).toMatchObject({ ok: false, kind: "timeout" });
    expect(errorsFor(events, a.t.id)).toHaveLength(1);
  });

  it("a child that closes between the kill and the grace timer is settled once: no SIGKILL, one error event", async () => {
    const slow = new HangingChild((s) => (s === "SIGTERM" ? 30 : 0));
    const { runner, events } = runnerWith(slow, 150);
    const a = await newThread();
    const outcome = await runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file });
    await sleep(300);
    expect(slow.signals).toEqual(["SIGTERM"]);
    expect(outcome).toMatchObject({ ok: false, kind: "timeout" });
    expect(errorsFor(events, a.t.id)).toHaveLength(1);
  });

  // 034: the stubborn child above closes on SIGKILL, so it cannot show that the runner settles without a close.
  it("a child that never closes, even after SIGKILL, is settled at the SIGKILL: the turn errors timeout with retry; the queue moves on", async () => {
    const stuck = new HangingChild(() => null);
    const { runner, events } = runnerWith(stuck, 100);
    const a = await newThread();
    const b = await newThread();
    const [oa, ob] = await Promise.all([
      runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file }),
      runner.enqueue(b.t.id, { kind: "new", screenshot: b.shot.file }),
    ]);
    expect(stuck.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(oa).toMatchObject({ ok: false, kind: "timeout" });
    expect(errorsFor(events, a.t.id)).toEqual([expect.objectContaining({ kind: "timeout", retry: true })]);
    expect(ob.ok).toBe(true);
  });

  it("a close that arrives after the SIGKILL settle changes nothing: no further events, one error, the outcome stays timeout", async () => {
    const late = new HangingChild((s) => (s === "SIGKILL" ? 150 : null));
    const { runner, events } = runnerWith(late, 100);
    const a = await newThread();
    const outcome = await runner.enqueue(a.t.id, { kind: "new", screenshot: a.shot.file });
    const settledEvents = events.length;
    await sleep(300);
    expect(late.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(events).toHaveLength(settledEvents);
    expect(errorsFor(events, a.t.id)).toEqual([expect.objectContaining({ kind: "timeout", retry: true })]);
    expect(outcome).toMatchObject({ ok: false, kind: "timeout" });
  });
});

// ── macOS login-shell PATH (028) ─────────────────────────────────────────────────────────────────────

describe("retry (050): re-runs the failed turn without adding its user turn again", () => {
  const failLines = [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded"] }];
  /** Each spawn's outcome in order: "ok:<answer>" or "fail". */
  function scripted(...plan: string[]) {
    let n = 0;
    script = (child, call) => {
      const step = plan[n++] ?? "ok:x";
      if (step === "fail") child.script(failLines, 1);
      else child.script(okLines(call, step.slice(3)));
    };
  }
  const shape = (t: Thread["turns"][number]) =>
    t.role === "user" ? `user:${t.kind === "text" ? t.text : t.file}` : t.isError ? "error" : `answer:${t.text}`;
  const sentMessage = (i: number) => JSON.parse(calls[i].child.written) as ReturnType<typeof buildUserMessage>;

  it("a failed follow-up retried: its user turn once, then the errored answer, then the new answer; sent once", async () => {
    scripted("ok:x = 4", "fail", "ok:because");
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect((await runner.enqueue(t.id, { kind: "followUp", text: "why?" })).ok).toBe(false);
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    const saved = await store.getThread(t.id);
    expect(saved.turns.map(shape)).toEqual(["user:001.png", "answer:x = 4", "user:why?", "error", "answer:because"]);
    expect(saved.status).toBe("done");
    // No owned transcript here (the fake writes none), so the retry is the fallback: screenshot, earlier answer, question.
    expect(sentMessage(2)).toEqual(buildFallbackMessage([PNG], ["x = 4"], "why?"));
    expect(events.filter((e) => e.type === "done")).toHaveLength(2);
  });

  it("a failed first screenshot retried: one screenshot turn; the message carries the image once", async () => {
    scripted("fail", "ok:x = 4");
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    expect((await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).ok).toBe(false);
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    expect((await store.getThread(t.id)).turns.map(shape)).toEqual(["user:001.png", "error", "answer:x = 4"]);
    const message = sentMessage(1);
    expect(message).toEqual(buildUserMessage("new", [PNG]));
    expect(message.message.content.filter((b) => b.type === "image")).toHaveLength(1);
    expect(message.message.content).toContainEqual({ type: "text", text: NEW_TEXT });
    // A fresh session: the failed attempt's session id is never reused.
    expect(calls[1].args).toContain("--session-id");
    expect(calls[1].args[calls[1].args.indexOf("--session-id") + 1]).not.toBe(t.sessionId);
  });

  it("a failed append retried: each screenshot once, the append question", async () => {
    scripted("ok:x = 4", "fail", "ok:part two");
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    const second = await store.saveScreenshot(t.id, Buffer.from("png2"));
    expect((await runner.enqueue(t.id, { kind: "append", screenshot: second.file })).ok).toBe(false);
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    expect((await store.getThread(t.id)).turns.map(shape)).toEqual(["user:001.png", "answer:x = 4", "user:002.png", "error", "answer:part two"]);
    expect(sentMessage(2)).toEqual(buildFallbackMessage([PNG, PNG], ["x = 4"], APPEND_TEXT));
  });

  it("a turn that failed before claude ran (no errored answer) is retried the same way", async () => {
    let loads = 0;
    const { runner } = makeRunner({
      loadSendImage: async () => {
        if (loads++ === 0) throw new Error("cannot read image");
        return PNG;
      },
    });
    const { t, shot } = await newThread();
    expect((await runner.enqueue(t.id, { kind: "new", screenshot: shot.file })).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    expect((await store.getThread(t.id)).turns.map(shape)).toEqual(["user:001.png", "answer:x = 4"]);
  });

  it("with an owned transcript the retry resumes it and sends only the follow-up", async () => {
    let n = 0;
    script = (child, call) => {
      n++;
      if (n === 1) {
        // The first turn's transcript lands in claude's projects dir; the store adopts it into the thread dir.
        const sid = call.args[call.args.indexOf("--session-id") + 1];
        const dir = path.join(root, "projects", "C--snapsolve-sessions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: "user", sessionId: sid })}\n`);
        child.script(okLines(call, "x = 4"));
      } else if (n === 2) child.script(failLines, 1);
      else child.script(okLines(call, "because"));
    };
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    const owned = (await store.getThread(t.id)).transcriptPath;
    expect(owned).not.toBeNull();
    expect((await runner.enqueue(t.id, { kind: "followUp", text: "why?" })).ok).toBe(false);
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    expect(calls[2].args.slice(-2)).toEqual(["--resume", owned]);
    expect(sentMessage(2)).toEqual(buildUserMessage("followUp", [], "why?"));
    expect((await store.getThread(t.id)).turns.map(shape)).toEqual(["user:001.png", "answer:x = 4", "user:why?", "error", "answer:because"]);
  });

  it("nothing to retry (the last turn is a successful answer, or no user turn): no spawn, the thread is untouched", async () => {
    scripted("ok:x = 4");
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    const before = await store.getThread(t.id);
    const outcome = await runner.enqueue(t.id, { kind: "retry" });
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await store.getThread(t.id)).toEqual(before);
    expect(events.at(-1)).toMatchObject({ type: "error", threadId: t.id });

    const empty = await store.createThread({ model: "opus", effort: "high" });
    expect((await runner.enqueue(empty.id, { kind: "retry" })).ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect((await store.getThread(empty.id)).turns).toEqual([]);
  });
});

describe("seeded new thread (051): the 7th append carries the previous thread's last answer", () => {
  const SEED = "The previous answer: $x = 4$.";
  const failLines = [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded"] }];
  function scripted(...plan: string[]) {
    let n = 0;
    script = (child, call) => {
      const step = plan[n++] ?? "ok:x";
      if (step === "fail") child.script(failLines, 1);
      else child.script(okLines(call, step.slice(3)));
    };
  }
  const sentMessage = (i: number) => JSON.parse(calls[i].child.written) as ReturnType<typeof buildUserMessage>;

  it("seededQuestion: the header, the previous answer, then the append question", () => {
    const text = seededQuestion(SEED);
    expect(text.startsWith(`${SEED_HEADER}\n\n${SEED}`)).toBe(true);
    expect(text.endsWith(APPEND_TEXT)).toBe(true);
    expect(text).not.toContain(NEW_TEXT);
  });

  it("the first stdin message has the image once, then the previous answer as text; a new session; the seed is saved on the user turn", async () => {
    scripted("ok:part two");
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    expect(await runner.enqueue(t.id, { kind: "new", screenshot: shot.file, seed: SEED })).toMatchObject({ ok: true });
    const message = sentMessage(0);
    expect(message.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
      { type: "text", text: seededQuestion(SEED) },
    ]);
    expect(calls[0].args).toContain("--session-id");
    expect(calls[0].args).not.toContain("--resume");
    const saved = await store.getThread(t.id);
    expect(saved.turns[0]).toEqual({ role: "user", kind: "screenshot", file: "001.png", seed: SEED });
    expect(saved.turns).toHaveLength(2);
  });

  it("the saved user turn is emitted (turn) after status and before any delta: the seed reaches the card at the turn's start (057)", async () => {
    scripted("ok:part two");
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file, seed: SEED });
    const types = events.map((e) => e.type);
    expect(types.filter((x) => x === "turn")).toHaveLength(1);
    expect(types.indexOf("status")).toBeLessThan(types.indexOf("turn"));
    expect(types.indexOf("turn")).toBeLessThan(types.indexOf("delta"));
    const turn = events.find((e) => e.type === "turn") as { threadId: string; thread: Thread };
    expect(turn.threadId).toBe(t.id);
    expect(turn.thread.status).toBe("running");
    expect(turn.thread.turns).toEqual([{ role: "user", kind: "screenshot", file: "001.png", seed: SEED }]);
  });

  it("a follow-up emits turn with its question last; a retry adds no user turn and emits no turn (057)", async () => {
    scripted("ok:x = 4", "fail", "ok:because");
    const { runner, events } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect((await runner.enqueue(t.id, { kind: "followUp", text: "why?" })).ok).toBe(false);
    const turns = events.filter((e) => e.type === "turn") as { thread: Thread }[];
    expect(turns).toHaveLength(2);
    expect(turns[1].thread.turns.at(-1)).toEqual({ role: "user", kind: "text", text: "why?" });
    events.length = 0;
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    expect(events.some((e) => e.type === "turn")).toBe(false);
  });

  it("a new thread without a seed is unchanged: NEW_TEXT and no seed on the turn", async () => {
    scripted("ok:x = 4");
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file });
    expect(sentMessage(0)).toEqual(buildUserMessage("new", [PNG]));
    expect((await store.getThread(t.id)).turns[0]).toEqual({ role: "user", kind: "screenshot", file: "001.png" });
  });

  it("a failed seeded first turn retried still sends the previous answer (once) and keeps one user turn", async () => {
    scripted("fail", "ok:part two");
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    expect((await runner.enqueue(t.id, { kind: "new", screenshot: shot.file, seed: SEED })).ok).toBe(false);
    expect(await runner.enqueue(t.id, { kind: "retry" })).toMatchObject({ ok: true });
    const message = sentMessage(1);
    expect(message.message.content.filter((b) => b.type === "image")).toHaveLength(1);
    const texts = message.message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    expect(texts.join("\n").split(SEED)).toHaveLength(2);
    expect(texts.join("\n")).toContain(APPEND_TEXT);
    const turns = (await store.getThread(t.id)).turns;
    expect(turns.filter((x) => x.role === "user")).toEqual([{ role: "user", kind: "screenshot", file: "001.png", seed: SEED }]);
  });

  it("a later turn that takes the resume fallback lists the previous thread's answer first among the earlier answers", async () => {
    scripted("ok:part two", "ok:because");
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    await runner.enqueue(t.id, { kind: "new", screenshot: shot.file, seed: SEED });
    // The fake writes no transcript, so the follow-up is the fallback.
    await runner.enqueue(t.id, { kind: "followUp", text: "why?" });
    expect(sentMessage(1)).toEqual(buildFallbackMessage([PNG], [SEED, "part two"], "why?"));
  });

  it.each([
    ["an empty seed", ""],
    ["a blank seed", "  \n "],
    ["a non-string seed", 42],
  ])("%s is refused: no spawn, no user turn", async (_name, seed) => {
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    const outcome = await runner.enqueue(t.id, { kind: "new", screenshot: shot.file, seed } as unknown as TurnRequest);
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await store.getThread(t.id)).turns).toEqual([]);
  });

  it("an append request with a seed is refused (only a new thread is seeded)", async () => {
    const { runner } = makeRunner();
    const { t, shot } = await newThread();
    const outcome = await runner.enqueue(t.id, { kind: "append", screenshot: shot.file, seed: SEED } as unknown as TurnRequest);
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("withLoginShellPath", () => {
  const HOME = "/Users/eric";
  const EXTRAS = ["/opt/homebrew/bin", "/usr/local/bin", "/Users/eric/.local/bin"];

  /** A fake execFileSync that prints `stdout` (wrapped as the real shell would print the command's output). */
  function shellPrinting(stdout: string) {
    return vi.fn((_file: string, args: readonly string[]) => {
      const command = args[args.length - 1];
      // Run the printf the function asked for against a fake $PATH, so marker handling is exercised for real.
      return command.replace(/printf '([^']*)%s([^']*)' "\$PATH"/, (_m, pre: string, post: string) => `${pre}${stdout}${post}`);
    });
  }

  it("darwin: login PATH first, then the existing PATH, then the extras; duplicates dropped, order kept", () => {
    const execFileSync = shellPrinting("/opt/homebrew/bin:/usr/bin");
    const { env, warning } = withLoginShellPath({ PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }, { platform: "darwin", home: HOME, execFileSync });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin:/Users/eric/.local/bin");
    expect(warning).toBeNull();
    const [file, args, options] = execFileSync.mock.calls[0] as unknown as [string, string[], { timeout: number; killSignal: string }];
    expect(file).toBe("/bin/bash");
    expect(args[0]).toBe("-ilc");
    expect(args[1]).toContain('"$PATH"');
    expect(options.timeout).toBe(3000);
    // An interactive shell ignores SIGTERM, and execFileSync waits for the child to exit: only SIGKILL ends it at 3 s.
    expect(options.killSignal).toBe("SIGKILL");
  });

  it("darwin without SHELL uses /bin/zsh", () => {
    const execFileSync = shellPrinting("/usr/bin");
    withLoginShellPath({ PATH: "/usr/bin" }, { platform: "darwin", home: HOME, execFileSync });
    expect(execFileSync.mock.calls[0][0]).toBe("/bin/zsh");
  });

  it("darwin: an explicit shell option wins over SHELL", () => {
    const execFileSync = shellPrinting("/usr/bin");
    withLoginShellPath({ PATH: "/usr/bin", SHELL: "/bin/bash" }, { platform: "darwin", home: HOME, execFileSync, shell: "/opt/local/bin/fish" });
    expect(execFileSync.mock.calls[0][0]).toBe("/opt/local/bin/fish");
  });

  it("darwin: text an rc file prints before the PATH is ignored", () => {
    const execFileSync = vi.fn((_file: string, args: readonly string[]) => {
      const printed = shellPrinting("/opt/homebrew/bin:/usr/bin")(_file, args);
      return `Welcome to zsh!\nLast login: today\n${printed}`;
    });
    const { env } = withLoginShellPath({ PATH: "/bin" }, { platform: "darwin", home: HOME, execFileSync });
    expect(env.PATH).toBe(["/opt/homebrew/bin", "/usr/bin", "/bin", ...EXTRAS.slice(1)].join(":"));
  });

  it.each([
    ["throws", () => {
      throw new Error("spawnSync ENOENT");
    }],
    ["times out", () => {
      throw Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    }],
    ["prints nothing", () => ""],
  ])("darwin, the shell %s → existing PATH + the extras and a warning naming the shell; never throws", (_name, impl) => {
    const execFileSync = vi.fn(impl);
    const { env, warning } = withLoginShellPath(
      { PATH: "/usr/bin:/bin", SHELL: "/usr/local/bin/fish" },
      { platform: "darwin", home: HOME, execFileSync },
    );
    expect(env.PATH).toBe(["/usr/bin", "/bin", ...EXTRAS].join(":"));
    expect(warning).toContain("/usr/local/bin/fish");
  });

  it("darwin with no PATH at all and a failing shell → just the extras", () => {
    const { env } = withLoginShellPath({}, { platform: "darwin", home: HOME, execFileSync: vi.fn(() => "") });
    expect(env.PATH).toBe(EXTRAS.join(":"));
  });

  it.each(["win32", "linux"] as const)("%s: env returned unchanged, no shell run", (platform) => {
    const execFileSync = vi.fn();
    const input = { PATH: "C:\\bin", SHELL: "/bin/zsh", OTHER: "x" };
    const { env, warning } = withLoginShellPath(input, { platform, home: HOME, execFileSync });
    expect(env).toEqual(input);
    expect(warning).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not mutate its input; other keys pass through", () => {
    const input = { PATH: "/usr/bin", SHELL: "/bin/zsh", LANG: "en_US.UTF-8" };
    const copy = { ...input };
    const { env } = withLoginShellPath(input, { platform: "darwin", home: HOME, execFileSync: shellPrinting("/opt/homebrew/bin") });
    expect(input).toEqual(copy);
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.SHELL).toBe("/bin/zsh");
  });

  it("composes with buildEnv: the merged PATH survives, CLAUDECODE and API keys are still stripped", () => {
    const { env } = withLoginShellPath(
      { PATH: "/usr/bin", SHELL: "/bin/zsh", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk" },
      { platform: "darwin", home: HOME, execFileSync: shellPrinting("/opt/homebrew/bin") },
    );
    expect(buildEnv(env, false)).toEqual({ PATH: ["/opt/homebrew/bin", "/usr/bin", ...EXTRAS.slice(1)].join(":"), SHELL: "/bin/zsh" });
  });
});
