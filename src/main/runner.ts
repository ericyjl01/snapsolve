// Runs Claude turns (SPEC §3.1–3.5): builds argv, env and the stdin message, spawns `claude -p` once per turn,
// streams its events, serializes turns per thread under a global cap, kills on timeout, adopts a new session's
// transcript once its first turn exits (failed or not) and falls back to a fresh session carrying the thread's
// history when resume fails.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { type ErrorKind, SnapsolveError, userMessage } from "../shared/errors";
import type { AssistantTurn, Config, Effort, Thread, ThreadStatus, Turn, UserTurn } from "../shared/types";
import { type AuthStatus, formatUsage, isUsageBlocked, type UsageInfo, usageBlockedMessage } from "./auth";
import type { Logger } from "./log";
import type { Store } from "./store";
import { createLineSplitter, parseEvent, type RateWindow, type StreamEvent } from "./stream";

export const NEW_TEXT = "Solve the problem on this screen.";
// Every capture continues the current thread (065), so the screenshot may be a new problem.
export const APPEND_TEXT = "Here is another screenshot. If it is unrelated to the earlier problem, treat it as a new question.";
export const EARLIER_HEADER = "Earlier answers in this thread:";
export const SEED_HEADER = "The previous thread's last answer:";

const SCREENSHOT = /^(\d{3})\.png$/;
const STDERR_KEEP = 4096;
const KILL_GRACE_MS = 5000;

export interface Command {
  path: string;
  /** Arguments before claude's own (tests run the fake as `node fake-claude.mjs`). */
  prefixArgs: string[];
}

/** An image as sent to the model (already resized/re-encoded by the loader). `data` is base64. */
export interface SendImage {
  mediaType: "image/png" | "image/jpeg";
  data: string;
}

/**
 * `screenshot` is the `NNN.png` name from `store.saveScreenshot`. `seed` is the previous thread's last answer when an
 * append past the screenshot limit starts the thread (SPEC §2.3). `retry` re-runs the thread's failed last user turn
 * (SPEC §7.1 Retry) without adding it again; `retryTarget` says whether there is one.
 */
export type TurnRequest =
  | { kind: "new"; screenshot: string; seed?: string }
  | { kind: "append"; screenshot: string }
  | { kind: "followUp"; text: string; voice?: true }
  | { kind: "retry" };

/** A request that adds a user turn; a retry re-runs one of these. */
export type UserRequest = Exclude<TurnRequest, { kind: "retry" }>;

type ContentBlock =
  | { type: "image"; source: { type: "base64"; media_type: SendImage["mediaType"]; data: string } }
  | { type: "text"; text: string };

/** One stream-json input line. */
export interface UserMessage {
  type: "user";
  message: { role: "user"; content: ContentBlock[] };
}

export type RunnerEvent =
  | { type: "status"; threadId: string; status: ThreadStatus }
  /** The turn's user turn is saved: `thread` carries it, so the card shows it (and a seed's note) before the answer. */
  | { type: "turn"; threadId: string; thread: Thread }
  | { type: "thinking"; threadId: string }
  | { type: "delta"; threadId: string; text: string }
  | {
      type: "init";
      threadId: string;
      sessionId: string;
      apiKeySource: string | null;
      model: string | null;
      /** Billing goes to an API key although `allowApiKey` is false (SPEC §3.6). */
      apiKeyWarning: boolean;
    }
  | {
      type: "rateLimit";
      threadId: string;
      status: string;
      resetsAt: number | null;
      fiveHour: RateWindow | null;
      sevenDay: RateWindow | null;
    }
  | { type: "done"; threadId: string; thread: Thread; turn: AssistantTurn; note?: "resumeFallback" }
  | { type: "error"; threadId: string; kind: ErrorKind; message: string; retry: boolean; thread: Thread | null };

export type TurnOutcome = { ok: true; thread: Thread } | { ok: false; kind: ErrorKind; message: string };

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunnerDeps {
  command: Command | (() => Command);
  store: Store;
  config: Pick<Config, "maxConcurrent" | "timeoutSec" | "allowApiKey">;
  /** Contents of prompts/system.md. */
  systemPrompt: string;
  env: Readonly<Record<string, string | undefined>>;
  spawn: SpawnFn;
  /** `<data>/sessions`, claude's cwd; created before every spawn. */
  sessionsDir: string;
  now?: () => number;
  log: Logger;
  loadSendImage: (file: string) => Promise<SendImage>;
  /** How long a timed-out claude gets to exit after the first kill before SIGKILL; default `KILL_GRACE_MS`. */
  killGraceMs?: number;
  /** `claude auth status`, rechecked after an error result (SPEC §3.6); logged out turns the error into notLoggedIn. */
  checkAuth?: () => Promise<AuthStatus>;
}

export interface Runner {
  /** Queues a turn; resolves when it ends. Never rejects: failures arrive as `{ ok: false }` and an `error` event. */
  enqueue(threadId: string, request: TurnRequest): Promise<TurnOutcome>;
  /** Subscribes to every event; returns the unsubscribe function. */
  on(listener: (event: RunnerEvent) => void): () => void;
}

/** SPEC §3.1, exactly; the system prompt is one argv element. */
export function buildArgs(options: {
  model: string;
  effort: Effort;
  systemPrompt: string;
  session: { id: string } | { resume: string };
}): string[] {
  const args = [
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
    options.model,
    "--effort",
    options.effort,
    "--system-prompt",
    options.systemPrompt,
  ];
  if ("resume" in options.session) {
    if (!path.isAbsolute(options.session.resume)) {
      throw new SnapsolveError("internal", "--resume needs an absolute transcript path");
    }
    return [...args, "--resume", options.session.resume];
  }
  return [...args, "--session-id", options.session.id];
}

const LOGIN_PATH_BEGIN = "__SNAPSOLVE_PATH_BEGIN__";
const LOGIN_PATH_END = "__SNAPSOLVE_PATH_END__";
const LOGIN_SHELL_TIMEOUT_MS = 3000;

export type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; killSignal: "SIGKILL"; encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] },
) => string | Buffer;

/**
 * SPEC §3.2 (macOS): an app started from Finder or `open -a` gets launchd's minimal PATH, so the npm `claude` shim
 * (`#!/usr/bin/env node`) may not find node. On darwin, puts the login shell's PATH (read once, 3 s timeout) first,
 * then the current PATH, then Homebrew, /usr/local/bin and ~/.local/bin. The markers skip anything an rc file prints.
 * Never throws: a shell problem comes back as `warning`. Any other platform: env unchanged, no shell run.
 */
export function withLoginShellPath(
  env: Readonly<Record<string, string | undefined>>,
  options: { platform: NodeJS.Platform; home: string; execFileSync: ExecFileSyncFn; shell?: string },
): { env: Record<string, string | undefined>; warning: string | null } {
  if (options.platform !== "darwin") return { env: { ...env }, warning: null };
  const shell = options.shell ?? (env.SHELL || "/bin/zsh");
  let login: string[] = [];
  let warning: string | null = null;
  try {
    const out = String(
      options.execFileSync(shell, ["-ilc", `printf '${LOGIN_PATH_BEGIN}%s${LOGIN_PATH_END}' "$PATH"`], {
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        // An interactive shell ignores SIGTERM and execFileSync waits for the exit, so only SIGKILL keeps the 3 s bound.
        killSignal: "SIGKILL",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    const begin = out.indexOf(LOGIN_PATH_BEGIN);
    const end = begin < 0 ? -1 : out.indexOf(LOGIN_PATH_END, begin);
    const printed = end < 0 ? "" : out.slice(begin + LOGIN_PATH_BEGIN.length, end);
    if (printed) login = printed.split(":");
    else warning = `login shell ${shell} printed no PATH`;
  } catch (e) {
    warning = `cannot read the login PATH from ${shell}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", path.posix.join(options.home, ".local", "bin")];
  const merged = [...new Set([...login, ...(env.PATH ?? "").split(":"), ...extras].filter((p) => p !== ""))];
  return { env: { ...env, PATH: merged.join(":") }, warning };
}

/** SPEC §3.2: a copy without Claude Code's session markers and, unless allowed, the API key variables. */
export function buildEnv(env: Readonly<Record<string, string | undefined>>, allowApiKey: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const name = key.toUpperCase(); // Windows variable names are case-insensitive
    if (name.startsWith("CLAUDECODE") || name === "CLAUDE_CODE_ENTRYPOINT") continue;
    if (!allowApiKey && (name === "ANTHROPIC_API_KEY" || name === "ANTHROPIC_AUTH_TOKEN")) continue;
    out[key] = value;
  }
  return out;
}

export function buildUserMessage(kind: UserRequest["kind"], images: SendImage[], text?: string): UserMessage {
  if (kind === "followUp") return userLine([{ type: "text", text: text ?? "" }]);
  return userLine([...images.map(imageBlock), { type: "text", text: text ?? (kind === "new" ? NEW_TEXT : APPEND_TEXT) }]);
}

/** SPEC §2.3: a seeded thread's first question, the previous thread's last answer before the append question. */
export function seededQuestion(seed: string): string {
  return `${SEED_HEADER}\n\n${seed}\n\n---\n\n${APPEND_TEXT}`;
}

/** The first message of a replacement session (SPEC §3.4): every screenshot, the earlier answers, the question. */
export function buildFallbackMessage(images: SendImage[], answers: string[], question: string): UserMessage {
  const text = answers.length
    ? `${EARLIER_HEADER}\n\n${answers.join("\n\n---\n\n")}\n\n---\n\n${question}`
    : question;
  return userLine([...images.map(imageBlock), { type: "text", text }]);
}

interface Job {
  threadId: string;
  request: TurnRequest;
  resolve: (outcome: TurnOutcome) => void;
}

type Mode = "first" | "resume" | "fallback";

interface Attempt {
  result: Extract<StreamEvent, { type: "result" }> | null;
  text: string;
  sawText: boolean;
  ttftMs: number | null;
  rateLimited: boolean;
  /** `system/init` said billing goes to an API key although `allowApiKey` is false. */
  apiKeyWarning: boolean;
  /** This attempt's latest `rate_limit_event`. */
  usage: UsageInfo | null;
  /** claude started (got a pid), so it may have written a transcript. */
  ran: boolean;
  spawnError: NodeJS.ErrnoException | null;
  timedOut: boolean;
  code: number | null;
  stderr: string;
}

export function createRunner(deps: RunnerDeps): Runner {
  const { store, config, log } = deps;
  const now = deps.now ?? Date.now;
  const listeners = new Set<(event: RunnerEvent) => void>();
  const waiting: Job[] = [];
  const busy = new Set<string>();
  let running = 0;
  /** The latest `rate_limit_event` of any turn: while it blocks, turns fail before spawning (SPEC §3.6). */
  let usage: UsageInfo | null = null;

  function emit(event: RunnerEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (e) {
        log.error("runner.listenerFailed", { event: event.type, error: e });
      }
    }
  }

  function pump(): void {
    while (running < Math.max(1, config.maxConcurrent)) {
      const i = waiting.findIndex((job) => !busy.has(job.threadId));
      if (i < 0) return;
      const [job] = waiting.splice(i, 1);
      running++;
      busy.add(job.threadId);
      void run(job.threadId, job.request)
        .catch((e: unknown) => fail(job.threadId, e, null))
        .then((outcome) => {
          running--;
          busy.delete(job.threadId);
          job.resolve(outcome);
          pump();
        });
    }
  }

  async function setStatus(threadId: string, status: ThreadStatus): Promise<Thread> {
    emit({ type: "status", threadId, status });
    return store.updateThread(threadId, { status });
  }

  /**
   * Emits `error` and, when `record`, saves the errored assistant turn (if claude ran, or `turn`) and the error
   * status. An error result first rechecks `claude auth status`. Never throws.
   */
  async function fail(
    threadId: string,
    e: unknown,
    attempt: Attempt | null,
    { startedAt = now(), record = true, turn: saveTurn = attempt !== null } = {},
  ): Promise<TurnOutcome> {
    let { kind, message } = classifyError(e);
    // The error carries the details (stderr tail, exception, stack); never the answer text.
    log.warn("runner.turnFailed", { threadId, kind, code: attempt?.code ?? null, error: e });
    if (attempt?.result?.isError && kind !== "notLoggedIn" && kind !== "usageLimit" && (await loggedOut())) {
      kind = "notLoggedIn";
      message = userMessage(kind);
    }
    let thread: Thread | null = null;
    if (record && kind !== "threadNotFound") {
      try {
        if (saveTurn) {
          const turn: AssistantTurn = {
            role: "assistant",
            text: attempt?.text ?? "",
            durationMs: attempt?.result?.durationMs ?? now() - startedAt,
            ttftMs: attempt?.result?.ttftMs ?? attempt?.ttftMs ?? null,
            costUsd: attempt?.result?.totalCostUsd ?? null,
            isError: true,
            errorKind: kind,
            errorMessage: message,
            ...(attempt ? annotations(attempt) : {}),
          };
          await store.appendTurn(threadId, turn);
        }
        thread = await setStatus(threadId, "error");
      } catch (saveError) {
        log.error("runner.saveFailed", { threadId, error: saveError });
      }
    }
    emit({ type: "error", threadId, kind, message, retry: kind !== "threadNotFound", thread });
    return { ok: false, kind, message };
  }

  /** True only when `claude auth status` answered and said logged out; any failure to check is not a verdict. */
  async function loggedOut(): Promise<boolean> {
    if (!deps.checkAuth) return false;
    try {
      const auth = await deps.checkAuth();
      return auth.kind === "ok" && !auth.loggedIn;
    } catch (e) {
      log.warn("runner.authCheckFailed", { error: e });
      return false;
    }
  }

  async function run(threadId: string, request: TurnRequest): Promise<TurnOutcome> {
    const startedAt = now();
    let thread = await store.getThread(threadId);
    // A retry re-runs the failed last user turn where it stands; any other request adds its user turn first.
    let target: { request: UserRequest; index: number } | null;
    if (request.kind === "retry") {
      target = retryTarget(thread);
      if (!target) return fail(threadId, new SnapsolveError("internal", "nothing to retry"), null, { record: false });
      thread = await setStatus(threadId, "running");
    } else {
      await setStatus(threadId, "running");
      thread = await store.appendTurn(threadId, userTurn(request));
      emit({ type: "turn", threadId, thread });
      target = { request, index: thread.turns.length - 1 };
    }
    const asked = target.request;
    if (usage && isUsageBlocked(usage, now())) {
      log.info("runner.usageBlocked", { threadId, status: usage.status, resetsAt: usage.resetsAt });
      const blocked = new SnapsolveError("usageLimit", usageBlockedMessage(usage.resetsAt as number, now()));
      return fail(threadId, blocked, null, { startedAt, turn: true });
    }
    const prior = thread.turns.slice(0, target.index);
    const answers = prior.filter(isAnswer).map((t) => t.text);
    // A seeded thread's later turns carry the previous thread's answer as the earliest one (the first turn's own
    // question already holds it).
    const seed = target.index > 0 ? threadSeed(thread) : undefined;
    const earlier = seed === undefined ? answers : [seed, ...answers];

    // A retry never starts a session under the failed attempt's id (claude may have created it): it resumes the
    // owned transcript or starts a fresh one carrying the thread's screenshots, each once.
    let mode: Mode = prior.length === 0 && request.kind !== "retry" ? "first" : "fallback";
    if (thread.transcriptPath && !thread.transcriptMissing && (await isFile(thread.transcriptPath))) mode = "resume";

    let attempt: Attempt | null = null;
    let note: "resumeFallback" | undefined;
    if (mode === "resume") {
      attempt = await spawnTurn(thread, { resume: thread.transcriptPath as string }, await requestMessage(thread, asked));
      if (isResumeFailure(attempt)) {
        log.warn("runner.resumeFailed", { threadId, sessionId: thread.sessionId });
        mode = "fallback";
      }
    }
    if (mode === "fallback") {
      thread = await store.replaceSession(threadId);
      if (answers.length > 0) note = "resumeFallback";
      const images = await Promise.all(screenshotFiles(thread.turns).map((f) => deps.loadSendImage(screenshotPath(thread, f))));
      attempt = await spawnTurn(thread, { id: thread.sessionId }, buildFallbackMessage(images, earlier, question(asked)));
    } else if (mode === "first") {
      attempt = await spawnTurn(thread, { id: thread.sessionId }, await requestMessage(thread, asked));
    }
    if (!attempt) throw new SnapsolveError("internal", `no attempt for mode ${mode}`);

    // SPEC §3.4: a new session's transcript (it holds the screenshots) leaves claude's projects dir as soon as
    // its first turn exits, whatever the outcome; a resumed one is already in the thread dir.
    if (mode !== "resume" && attempt.ran) await adopt(threadId, thread.sessionId);
    if (!attempt.result || attempt.result.isError || attempt.spawnError) {
      return fail(threadId, attemptError(attempt), attempt, { startedAt });
    }
    const result = attempt.result;
    const turn: AssistantTurn = {
      role: "assistant",
      text: result.result ?? attempt.text,
      durationMs: result.durationMs ?? now() - startedAt,
      ttftMs: result.ttftMs ?? attempt.ttftMs,
      costUsd: result.totalCostUsd,
      isError: false,
      ...(note ? { note } : {}),
      ...annotations(attempt),
    };
    await store.appendTurn(threadId, turn);
    thread = await setStatus(threadId, "done");
    emit({ type: "done", threadId, thread, turn, ...(note ? { note } : {}) });
    return { ok: true, thread };
  }

  /** Never throws: a transcript that cannot be adopted is logged and the turn's own outcome stands. */
  async function adopt(threadId: string, sessionId: string): Promise<void> {
    try {
      const adopted = await store.adoptTranscript(threadId, sessionId);
      if (!adopted.ok) log.warn("runner.transcriptNotAdopted", { threadId, sessionId, reason: adopted.reason });
    } catch (e) {
      log.warn("runner.transcriptNotAdopted", { threadId, sessionId, error: e });
    }
  }

  async function requestMessage(thread: Thread, request: UserRequest): Promise<UserMessage> {
    if (request.kind === "followUp") return buildUserMessage("followUp", [], request.text);
    return buildUserMessage(request.kind, [await deps.loadSendImage(screenshotPath(thread, request.screenshot))], question(request));
  }

  function screenshotPath(thread: Thread, file: string): string {
    return store.screenshotPath(thread.id, Number((SCREENSHOT.exec(file) as RegExpExecArray)[1]));
  }

  async function spawnTurn(thread: Thread, session: { id: string } | { resume: string }, message: UserMessage): Promise<Attempt> {
    const attempt: Attempt = {
      result: null,
      text: "",
      sawText: false,
      ttftMs: null,
      rateLimited: false,
      apiKeyWarning: false,
      usage: null,
      ran: false,
      spawnError: null,
      timedOut: false,
      code: null,
      stderr: "",
    };
    const command = typeof deps.command === "function" ? deps.command() : deps.command;
    const args = [
      ...command.prefixArgs,
      ...buildArgs({ model: thread.model, effort: thread.effort, systemPrompt: deps.systemPrompt, session }),
    ];
    await mkdir(deps.sessionsDir, { recursive: true });
    const startedAt = now();
    let child: ChildProcess;
    try {
      child = deps.spawn(command.path, args, {
        cwd: deps.sessionsDir,
        env: buildEnv(deps.env, config.allowApiKey),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      attempt.spawnError = e as NodeJS.ErrnoException;
      return attempt;
    }
    attempt.ran = child.pid !== undefined; // Node leaves pid unset when the process could not be started
    log.info("runner.spawn", {
      threadId: thread.id,
      sessionId: thread.sessionId,
      resume: "resume" in session,
      pid: child.pid ?? null,
    });

    let thinkingShown = false;
    const handle = (line: string) => {
      const event = parseEvent(line);
      if (!event) return;
      switch (event.type) {
        case "text":
          attempt.ttftMs ??= now() - startedAt;
          attempt.sawText = true;
          attempt.text += event.text;
          emit({ type: "delta", threadId: thread.id, text: event.text });
          return;
        case "thinking":
          if (thinkingShown || attempt.sawText) return;
          thinkingShown = true;
          emit({ type: "thinking", threadId: thread.id });
          return;
        case "init":
          attempt.apiKeyWarning = !config.allowApiKey && event.apiKeySource !== null && event.apiKeySource !== "none";
          emit({
            type: "init",
            threadId: thread.id,
            sessionId: event.sessionId,
            apiKeySource: event.apiKeySource,
            model: event.model,
            apiKeyWarning: attempt.apiKeyWarning,
          });
          return;
        case "rateLimit":
          attempt.rateLimited ||= !event.status.startsWith("allowed");
          usage = { status: event.status, resetsAt: event.resetsAt, fiveHour: event.fiveHour, sevenDay: event.sevenDay };
          attempt.usage = usage;
          emit({
            type: "rateLimit",
            threadId: thread.id,
            status: event.status,
            resetsAt: event.resetsAt,
            fiveHour: event.fiveHour,
            sevenDay: event.sevenDay,
          });
          return;
        case "result":
          attempt.result = event;
          return;
      }
    };

    return new Promise<Attempt>((resolve) => {
      const splitter = createLineSplitter();
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        log.info("runner.exit", {
          threadId: thread.id,
          code: attempt.code,
          timedOut: attempt.timedOut,
          ms: now() - startedAt,
        });
        resolve(attempt);
      };
      const timer = setTimeout(() => {
        attempt.timedOut = true;
        log.warn("runner.timeout", { threadId: thread.id, timeoutSec: config.timeoutSec, pid: child.pid ?? null });
        child.kill();
        // A claude that ignores SIGTERM (seen as a risk on macOS) must not outlive its turn.
        graceTimer = setTimeout(() => {
          log.warn("runner.sigkill", { threadId: thread.id, pid: child.pid ?? null });
          child.kill("SIGKILL");
          settle();
        }, deps.killGraceMs ?? KILL_GRACE_MS);
      }, config.timeoutSec * 1000);

      child.on("error", (e: NodeJS.ErrnoException) => {
        attempt.spawnError ??= e;
        if (child.pid !== undefined && child.exitCode === null) child.kill();
        settle();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) handle(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        attempt.stderr = (attempt.stderr + chunk.toString()).slice(-STDERR_KEEP);
      });
      child.on("close", (code: number | null) => {
        for (const line of splitter.end()) handle(line);
        attempt.code = code;
        settle();
      });
      child.stdin?.on("error", () => undefined); // EPIPE when claude exits before reading
      child.stdin?.end(`${JSON.stringify(message)}\n`);
    });
  }

  return {
    enqueue(threadId, request) {
      return new Promise<TurnOutcome>((resolve) => {
        const problem = requestProblem(request);
        if (problem) {
          void fail(threadId, new SnapsolveError("internal", problem), null, { record: false }).then(resolve);
          return;
        }
        waiting.push({ threadId, request, resolve });
        pump();
        if (waiting.some((job) => job.threadId === threadId) && !busy.has(threadId)) {
          setStatus(threadId, "queued").catch((e: unknown) => log.warn("runner.statusFailed", { threadId, error: e }));
        }
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function userLine(content: ContentBlock[]): UserMessage {
  return { type: "user", message: { role: "user", content } };
}

function imageBlock(image: SendImage): ContentBlock {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
}

function userTurn(request: UserRequest): UserTurn {
  if (request.kind === "followUp") return { role: "user", kind: "text", text: request.text, ...(request.voice ? { voice: true as const } : {}) };
  const turn: UserTurn = { role: "user", kind: "screenshot", file: request.screenshot };
  return request.kind === "new" && request.seed !== undefined ? { ...turn, seed: request.seed } : turn;
}

function question(request: UserRequest): string {
  if (request.kind === "followUp") return request.text;
  if (request.kind === "append") return APPEND_TEXT;
  return request.seed === undefined ? NEW_TEXT : seededQuestion(request.seed);
}

/** The seed on the thread's first user turn, if that turn is a seeded screenshot. */
function threadSeed(thread: Thread): string | undefined {
  const first = thread.turns.find((t): t is UserTurn => t.role === "user");
  return first?.kind === "screenshot" ? first.seed : undefined;
}

function screenshotFiles(turns: Turn[]): string[] {
  return turns.flatMap((t) => (t.role === "user" && t.kind === "screenshot" ? [t.file] : []));
}

/** What the card shows next to an answer: the API-key warning and the usage line (SPEC §3.6). */
function annotations(attempt: Attempt): Pick<AssistantTurn, "warning" | "usage"> {
  const line = attempt.usage ? formatUsage(attempt.usage) : "";
  return { ...(attempt.apiKeyWarning ? { warning: "apiKeyInUse" as const } : {}), ...(line ? { usage: line } : {}) };
}

/**
 * The failed last user turn a retry re-runs, as the request that first ran it, and its index; only errored answers
 * may follow it. Null when the last turn is a successful answer or there is no user turn.
 */
export function retryTarget(thread: Thread): { request: UserRequest; index: number } | null {
  let index = thread.turns.length - 1;
  for (; index >= 0; index--) {
    const turn = thread.turns[index];
    if (turn.role === "user") break;
    if (!turn.isError) return null;
  }
  if (index < 0) return null;
  const turn = thread.turns[index] as UserTurn;
  if (turn.kind === "text") return { request: { kind: "followUp", text: turn.text, ...(turn.voice ? { voice: true as const } : {}) }, index };
  const first = !thread.turns.slice(0, index).some((t) => t.role === "user");
  if (!first) return { request: { kind: "append", screenshot: turn.file }, index };
  return { request: { kind: "new", screenshot: turn.file, ...(turn.seed !== undefined ? { seed: turn.seed } : {}) }, index };
}

function isAnswer(turn: Turn): turn is AssistantTurn {
  return turn.role === "assistant" && !turn.isError;
}

function requestProblem(request: TurnRequest): string | null {
  if (request.kind === "retry") return null;
  if (request.kind === "followUp") {
    const voice: unknown = (request as { voice?: unknown }).voice;
    if (voice !== undefined && voice !== true) return "invalid voice mark";
    return typeof request.text === "string" && request.text.trim() !== "" ? null : "empty follow-up";
  }
  if (request.kind === "new" || request.kind === "append") {
    if (!(typeof request.screenshot === "string" && SCREENSHOT.test(request.screenshot))) return "invalid screenshot";
    const seed: unknown = (request as { seed?: unknown }).seed;
    if (seed === undefined) return null;
    if (request.kind === "append") return "only a new thread is seeded";
    return typeof seed === "string" && seed.trim() !== "" ? null : "invalid seed";
  }
  return "unknown turn kind";
}

/** "No conversation found" before any answer text: the transcript is missing or unreadable (measured, 005). */
function isResumeFailure(attempt: Attempt): boolean {
  if (attempt.sawText || attempt.spawnError || attempt.timedOut || (attempt.result && !attempt.result.isError)) return false;
  const said = [...(attempt.result?.errors ?? []), attempt.result?.result ?? "", attempt.stderr].join("\n");
  return /no conversation found/i.test(said);
}

function attemptError(attempt: Attempt): SnapsolveError {
  const e = attempt.spawnError;
  if (e) {
    const cause = spawnFailure(e);
    return e.code === "ENOENT"
      ? new SnapsolveError("claudeNotFound", undefined, { cause })
      : new SnapsolveError("internal", `cannot start claude (${cause.code ?? cause.message})`, { cause });
  }
  if (attempt.timedOut) return new SnapsolveError("timeout");
  const resultText = attempt.result?.result ?? "";
  const otherwise = attempt.result?.errors.join("\n") || attempt.stderr.trim();
  // Classification reads everything Claude said; the message (logged as runner.turnFailed) leaves out a result that
  // follows streamed answer text, since that result is the answer (ARCHITECTURE `## Do NOT`, task 047).
  const said = resultText || otherwise;
  const hideResult = attempt.sawText && resultText !== "";
  const details = hideResult ? [otherwise, `result: ${resultText.length} chars omitted`].filter(Boolean).join("\n") : said;
  if (attempt.rateLimited || /usage limit|rate limit/i.test(said)) {
    return new SnapsolveError("usageLimit", (hideResult ? otherwise : said) || userMessage("usageLimit"));
  }
  if (/not logged in|please run \/login|invalid api key|oauth token/i.test(said)) {
    return new SnapsolveError("notLoggedIn", details);
  }
  const exit = attempt.result ? "claude reported an error" : `claude exited with code ${attempt.code ?? "?"} without a result`;
  return new SnapsolveError("internal", details ? `${exit}: ${details}` : exit);
}

/**
 * What a spawn error says about the failure, for the log. Never the error itself: Node's spawn errors also carry
 * `spawnargs`, the whole argv with the system prompt (ARCHITECTURE `## Do NOT`).
 */
function spawnFailure(e: NodeJS.ErrnoException): { code: string | null; syscall: string | null; path: string | null; message: string } {
  return { code: e.code ?? null, syscall: e.syscall ?? null, path: e.path ?? null, message: e.message ?? String(e) };
}

/** The card's error: Claude's own words for a usage limit, the fixed text for the rest (details are logged). */
function classifyError(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof SnapsolveError) {
    return { kind: e.kind, message: e.kind === "usageLimit" ? e.message : userMessage(e.kind) };
  }
  return { kind: "internal", message: userMessage("internal") };
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}
