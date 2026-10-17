import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLineSplitter, parseEvent, type StreamEvent } from "../../src/main/stream";
import { fixturesDir } from "../paths";

const streamDir = path.join(fixturesDir, "stream");
const fixture = (name: string) => readFileSync(path.join(streamDir, name));
const SUCCESS_FIXTURES = ["text-sonnet-low.jsonl", "image-sonnet-low.jsonl", "thinking-opus-high.jsonl"];

/** Feeds `bytes` to a fresh splitter in chunks of the given sizes (cycled), then flushes. */
function splitAll(bytes: Buffer, sizes: number[]): string[] {
  const splitter = createLineSplitter();
  const lines: string[] = [];
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length];
    lines.push(...splitter.push(bytes.subarray(at, at + size)));
    at += size;
  }
  return [...lines, ...splitter.end()];
}

function events(bytes: Buffer, sizes = [4096]): StreamEvent[] {
  return splitAll(bytes, sizes)
    .map(parseEvent)
    .filter((e): e is StreamEvent => e !== null);
}

const line = (o: unknown) => JSON.stringify(o);
const streamEvent = (event: unknown) => line({ type: "stream_event", event, session_id: "s", parent_tool_use_id: null });

describe("createLineSplitter", () => {
  it("reassembles a line split across 3 chunks", () => {
    const s = createLineSplitter();
    expect(s.push('{"type":')).toEqual([]);
    expect(s.push('"result","is_')).toEqual([]);
    expect(s.push('error":false}\n')).toEqual(['{"type":"result","is_error":false}']);
    expect(s.end()).toEqual([]);
  });

  it("strips CRLF, including a \\r and \\n that arrive in different chunks", () => {
    const s = createLineSplitter();
    expect(s.push("a\r\nb\r")).toEqual(["a"]);
    expect(s.push("\nc\r\n")).toEqual(["b", "c"]);
  });

  it("returns several lines from one chunk, in order", () => {
    expect(createLineSplitter().push("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("flushes a trailing line without a newline on end", () => {
    const s = createLineSplitter();
    expect(s.push("one\ntail")).toEqual(["one"]);
    expect(s.end()).toEqual(["tail"]);
    expect(s.end()).toEqual([]);
  });

  it("skips empty and whitespace-only lines", () => {
    const s = createLineSplitter();
    expect(s.push("\n\r\n  \nx\n\t\n")).toEqual(["x"]);
    expect(s.push("   ")).toEqual([]);
    expect(s.end()).toEqual([]);
  });

  it("reassembles a multi-byte UTF-8 character split across byte chunks", () => {
    const bytes = Buffer.from("17 × 3 ✓ 漢\n", "utf8");
    for (let cut = 1; cut < bytes.length; cut++) {
      const s = createLineSplitter();
      const out = [...s.push(bytes.subarray(0, cut)), ...s.push(bytes.subarray(cut)), ...s.end()];
      expect(out, `cut at ${cut}`).toEqual(["17 × 3 ✓ 漢"]);
    }
  });

  it("any chunking of a recorded session yields the same lines as splitting the whole file", () => {
    for (const name of SUCCESS_FIXTURES) {
      const bytes = fixture(name);
      const expected = bytes.toString("utf8").split("\n").filter((l) => l.trim() !== "");
      for (const sizes of [[1], [7, 3, 50], [1000], [bytes.length]]) {
        expect(splitAll(bytes, sizes), `${name} ${sizes}`).toEqual(expected);
      }
    }
  });
});

describe("parseEvent", () => {
  it("content_block_delta / text_delta → text", () => {
    expect(parseEvent(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x = 4" } }))).toEqual({
      type: "text",
      text: "x = 4",
    });
  });

  it("other deltas and block events are not text", () => {
    for (const delta of [
      { type: "thinking_delta", thinking: "hmm" },
      { type: "signature_delta", signature: "abc" },
      { type: "input_json_delta", partial_json: "{}" },
      { type: "text_delta", text: 42 },
      { type: "text_delta" },
    ]) {
      expect(parseEvent(streamEvent({ type: "content_block_delta", index: 0, delta })), JSON.stringify(delta)).toBeNull();
    }
    expect(parseEvent(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }))).toBeNull();
    for (const type of ["message_start", "message_delta", "message_stop", "content_block_stop"]) {
      expect(parseEvent(streamEvent({ type, index: 0 })), type).toBeNull();
    }
  });

  it("a thinking content_block_start and system/thinking_tokens → thinking", () => {
    expect(
      parseEvent(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })),
    ).toEqual({ type: "thinking" });
    expect(
      parseEvent(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } })),
    ).toEqual({ type: "thinking" });
    expect(parseEvent(line({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }))).toEqual({ type: "thinking" });
  });

  it("system/init → sessionId, apiKeySource and model", () => {
    expect(
      parseEvent(line({ type: "system", subtype: "init", session_id: "sid-1", apiKeySource: "none", model: "claude-opus-5-5", tools: [] })),
    ).toEqual({ type: "init", sessionId: "sid-1", apiKeySource: "none", model: "claude-opus-5-5" });
    expect(parseEvent(line({ type: "system", subtype: "init", session_id: "sid-1" }))).toEqual({
      type: "init",
      sessionId: "sid-1",
      apiKeySource: null,
      model: null,
    });
    expect(parseEvent(line({ type: "system", subtype: "init" }))).toBeNull();
  });

  it("other system events are ignored", () => {
    for (const subtype of ["status", "ui_invalidate", "hook_response", undefined]) {
      expect(parseEvent(line({ type: "system", subtype, status: "requesting" })), String(subtype)).toBeNull();
    }
  });

  it("rate_limit_event → status, resetsAt and five-hour / seven-day utilization", () => {
    const e = parseEvent(
      line({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          resetsAt: 1791996600,
          rateLimitType: "five_hour",
          unifiedWindows: {
            five_hour: { utilization: 0.83, resetsAt: 1791996600 },
            seven_day: { utilization: 0.05, resetsAt: 1792530000 },
          },
        },
      }),
    );
    expect(e).toEqual({
      type: "rateLimit",
      status: "allowed_warning",
      resetsAt: 1791996600,
      rateLimitType: "five_hour",
      fiveHour: { utilization: 0.83, resetsAt: 1791996600 },
      sevenDay: { utilization: 0.05, resetsAt: 1792530000 },
    });
  });

  it("rate_limit_event without per-window data keeps what it has", () => {
    expect(parseEvent(line({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }))).toEqual({
      type: "rateLimit",
      status: "rejected",
      resetsAt: null,
      rateLimitType: null,
      fiveHour: null,
      sevenDay: null,
    });
    expect(parseEvent(line({ type: "rate_limit_event" }))).toBeNull();
    expect(parseEvent(line({ type: "rate_limit_event", rate_limit_info: { resetsAt: 1 } }))).toBeNull();
  });

  it("result success → isError false, durations, ttft, cost and the answer text", () => {
    expect(
      parseEvent(
        line({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 3336,
          duration_api_ms: 3016,
          ttft_ms: 1489,
          total_cost_usd: 0.010172,
          result: "**5:40 pm**",
          session_id: "sid-1",
        }),
      ),
    ).toEqual({
      type: "result",
      isError: false,
      subtype: "success",
      durationMs: 3336,
      durationApiMs: 3016,
      ttftMs: 1489,
      totalCostUsd: 0.010172,
      result: "**5:40 pm**",
      errors: [],
      sessionId: "sid-1",
    });
  });

  it("a result with missing fields gets nulls; is_error decides isError", () => {
    expect(parseEvent(line({ type: "result", is_error: true }))).toEqual({
      type: "result",
      isError: true,
      subtype: null,
      durationMs: null,
      durationApiMs: null,
      ttftMs: null,
      totalCostUsd: null,
      result: null,
      errors: [],
      sessionId: null,
    });
    expect(parseEvent(line({ type: "result", subtype: "error_max_turns" }))).toMatchObject({ isError: true });
    expect(parseEvent(line({ type: "result", subtype: "success" }))).toMatchObject({ isError: false });
  });

  it("is_error wins over subtype: an API error reported with subtype success is an error, Claude's text kept", () => {
    expect(
      parseEvent(line({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Resets 6pm." })),
    ).toMatchObject({ isError: true, subtype: "success", result: "Claude usage limit reached. Resets 6pm." });
    expect(parseEvent(line({ type: "result", subtype: "error_during_execution", is_error: false }))).toMatchObject({
      isError: false,
    });
  });

  it("the full assistant message is ignored, so text is never counted twice", () => {
    expect(
      parseEvent(line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x = 4" }] } })),
    ).toBeNull();
    expect(parseEvent(line({ type: "user", message: { role: "user", content: "hi" } }))).toBeNull();
  });

  it("unknown types → null", () => {
    expect(parseEvent(line({ type: "something_new", data: 1 }))).toBeNull();
    expect(parseEvent(line({ event: { type: "content_block_delta" } }))).toBeNull();
    expect(parseEvent(line({ type: 7 }))).toBeNull();
  });

  it("malformed or non-object JSON → null without throwing", () => {
    for (const bad of ["{", '{"type":"result"', "not json", "", "null", "42", '"result"', "[]", '[{"type":"result"}]']) {
      expect(() => parseEvent(bad), bad).not.toThrow();
      expect(parseEvent(bad), bad).toBeNull();
    }
    expect(parseEvent(streamEvent(null))).toBeNull();
    expect(parseEvent(streamEvent({ type: "content_block_delta", delta: null }))).toBeNull();
  });
});

describe("recorded sessions", () => {
  it("the fixtures are the four recorded sessions", () => {
    expect(readdirSync(streamDir).sort()).toEqual([
      "image-sonnet-low.jsonl",
      "resume-missing.jsonl",
      "text-sonnet-low.jsonl",
      "thinking-opus-high.jsonl",
    ]);
  });

  it("concatenated text events of each fixture equal its result text", () => {
    for (const name of SUCCESS_FIXTURES) {
      for (const sizes of [[4096], [5, 11]]) {
        const all = events(fixture(name), sizes);
        const text = all.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
        const result = all.filter((e) => e.type === "result");
        expect(result, name).toHaveLength(1);
        expect(result[0]).toMatchObject({ isError: false, subtype: "success" });
        expect(text.length, name).toBeGreaterThan(0);
        expect(text, name).toBe((result[0] as { result: string }).result);
      }
    }
  });

  it("each success session has one init (login, no API key), a usage update and a result with timings", () => {
    for (const name of SUCCESS_FIXTURES) {
      const all = events(fixture(name));
      const init = all.filter((e) => e.type === "init");
      expect(init, name).toHaveLength(1);
      expect(init[0]).toMatchObject({ apiKeySource: "none", sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      const rate = all.find((e) => e.type === "rateLimit");
      expect(rate, name).toMatchObject({
        status: "allowed",
        fiveHour: { utilization: expect.any(Number) },
        sevenDay: { utilization: expect.any(Number) },
      });
      expect(all.at(-1), name).toMatchObject({
        type: "result",
        durationMs: expect.any(Number),
        durationApiMs: expect.any(Number),
        ttftMs: expect.any(Number),
        totalCostUsd: expect.any(Number),
      });
      expect(all[0].type, name).toBe("init");
    }
  });

  it("opus/high reports thinking before the first text; sonnet/low does not think", () => {
    const opus = events(fixture("thinking-opus-high.jsonl")).map((e) => e.type);
    expect(opus).toContain("thinking");
    expect(opus.indexOf("thinking")).toBeLessThan(opus.indexOf("text"));
    expect(events(fixture("text-sonnet-low.jsonl")).map((e) => e.type)).not.toContain("thinking");
  });

  it("resuming a nonexistent session → one error result carrying 'No conversation found'", () => {
    const all = events(fixture("resume-missing.jsonl"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: "result", isError: true, subtype: "error_during_execution", result: null });
    expect((all[0] as { errors: string[] }).errors.join("\n")).toMatch(/No conversation found/);
  });
});
