// Scriptable stand-in for `claude -p --input-format stream-json --output-format stream-json` (tests only).
// Run as `node fake-claude.mjs <claude args>`. Behavior per FAKE_CLAUDE_SCENARIO (or the contents of the file
// FAKE_CLAUDE_SCENARIO_FILE, read at every start, so a running app can switch scenarios):
//   ok (default) · slow · hang · crash · error · no-conversation · not-logged-in · api-key · rate-limited
// `auth status` prints Claude Code's JSON (identity fields included) without reading stdin: logged in, or logged
// out (exit 1) for not-logged-in or FAKE_AUTH=logged-out; FAKE_AUTH=malformed prints text that is not JSON.
// Writes transcripts like claude: `--session-id <sid>` → $FAKE_PROJECTS/<encoded cwd>/<sid>.jsonl, `--resume <path>`
// → appends to <path> (missing or unparsable → "No conversation found"). Logs start/end, argv, env names, cwd and
// stdin as JSON lines to $FAKE_LOG. FAKE_ANSWER_SUFFIX is appended to every answer (e.g. math for the panel e2e).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const scenario = scenarioName();
const delayMs = Number(process.env.FAKE_DELAY_MS || 400);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function scenarioName() {
  const file = process.env.FAKE_CLAUDE_SCENARIO_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim() || "ok";
  return process.env.FAKE_CLAUDE_SCENARIO || "ok";
}

function log(entry) {
  if (process.env.FAKE_LOG) {
    appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ ...entry, pid: process.pid, time: Date.now() })}\n`);
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(code) {
  log({ event: "end", code });
  process.stdout.write("", () => process.exit(code));
}

function noConversation(sid) {
  const message = `No conversation found with session ID: ${sid}`;
  emit({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, session_id: sid, errors: [message] });
  process.stderr.write(`${message}\n`);
  finish(1);
}

function authStatus() {
  log({ event: "auth", argv, env: Object.keys(process.env).sort() });
  const auth = process.env.FAKE_AUTH || (scenario === "not-logged-in" ? "logged-out" : "ok");
  if (auth === "malformed") {
    process.stdout.write("Logged in as fake@example.com (Fake Org)\n");
    return finish(0);
  }
  if (auth === "logged-out") {
    emit({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    return finish(1);
  }
  emit({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "fake@example.com", orgId: "org-fake", orgName: "Fake Org", subscriptionType: "pro" });
  return finish(0);
}

async function main() {
  if (argv[0] === "auth" && argv[1] === "status") return authStatus();
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  const message = JSON.parse(stdin.trim());
  log({ event: "start", argv, cwd: process.cwd(), env: Object.keys(process.env).sort(), stdin: message });

  const resume = flag("--resume");
  const sid = resume ? path.basename(resume, ".jsonl") : flag("--session-id");
  let transcript;
  if (resume) {
    let ok = existsSync(resume);
    if (ok) {
      try {
        for (const l of readFileSync(resume, "utf8").split("\n")) if (l.trim()) JSON.parse(l);
      } catch {
        ok = false;
      }
    }
    if (!ok || scenario === "no-conversation") return noConversation(sid);
    transcript = resume;
  } else {
    const dir = path.join(process.env.FAKE_PROJECTS, process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    transcript = path.join(dir, `${sid}.jsonl`);
  }

  if (scenario === "not-logged-in") {
    emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sid, duration_ms: 5, duration_api_ms: 0, total_cost_usd: 0 });
    return finish(1);
  }

  emit({ type: "system", subtype: "init", session_id: sid, apiKeySource: scenario === "api-key" ? "ANTHROPIC_API_KEY" : "none", model: flag("--model"), tools: [] });

  if (scenario === "error") {
    emit({ type: "result", subtype: "success", is_error: true, result: "API Error: 401 authentication_error", session_id: sid, duration_ms: 15, duration_api_ms: 0, total_cost_usd: 0 });
    return finish(1);
  }

  if (scenario === "rate-limited") {
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791996600, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1791996600 }, seven_day: { utilization: 0.4, resetsAt: 1792530000 } } } });
    emit({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Your limit resets at 6pm.", session_id: sid, duration_ms: 20, duration_api_ms: 0, total_cost_usd: 0 });
    return finish(1);
  }

  const answers = existsSync(transcript)
    ? readFileSync(transcript, "utf8").split("\n").filter((l) => l.includes('"type":"assistant"')).length
    : 0;
  const images = message.message.content.filter((b) => b.type === "image").length;
  const answer = `Answer ${answers + 1}: saw ${images} image(s).${process.env.FAKE_ANSWER_SUFFIX ?? ""}`;
  appendFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: sid, message: message.message })}\n`);

  emit({ type: "stream_event", event: { type: "message_start", message: { role: "assistant", content: [] } }, session_id: sid });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, session_id: sid });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, session_id: sid });
  const pieces = [answer.slice(0, 7), answer.slice(7, 15), answer.slice(15)];
  for (const [i, text] of pieces.entries()) {
    if (scenario === "slow") await sleep(delayMs / pieces.length);
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, session_id: sid });
    if (scenario === "crash" && i === 1) {
      process.stderr.write("fake claude: simulated crash\n");
      return finish(1);
    }
    if (scenario === "hang" && i === 0) {
      setInterval(() => {}, 60_000);
      return;
    }
  }
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] }, session_id: sid });
  appendFileSync(transcript, `${JSON.stringify({ type: "assistant", sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: answer }] } })}\n`);
  emit({ type: "stream_event", event: { type: "message_stop" }, session_id: sid });
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1791996600, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1791996600 }, seven_day: { utilization: 0.34, resetsAt: 1792530000 } } } });
  emit({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sid, duration_ms: 1234, duration_api_ms: 1100, ttft_ms: 321, total_cost_usd: 0.0123 });
  finish(0);
}

main().catch((e) => {
  process.stderr.write(`fake claude failed: ${e?.stack ?? e}\n`);
  finish(2);
});
