// `claude -p --output-format stream-json` output (SPEC §3.3): a line splitter for stdout chunks and a classifier
// for the few events snapsolve uses. Pure; unknown events and malformed lines become null, never an exception.
import { StringDecoder } from "node:string_decoder";

export interface LineSplitter {
  /** Complete, non-blank lines in this chunk (CR/LF stripped); a partial line waits for the next chunk. */
  push(chunk: string | Uint8Array): string[];
  /** The last line if stdout ended without a newline. */
  end(): string[];
}

export interface RateWindow {
  /** 0–1 share of the window used. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number | null;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking" }
  | { type: "init"; sessionId: string; apiKeySource: string | null; model: string | null }
  | {
      type: "rateLimit";
      status: string;
      resetsAt: number | null;
      rateLimitType: string | null;
      fiveHour: RateWindow | null;
      sevenDay: RateWindow | null;
    }
  | {
      type: "result";
      isError: boolean;
      subtype: string | null;
      durationMs: number | null;
      durationApiMs: number | null;
      ttftMs: number | null;
      totalCostUsd: number | null;
      /** The final answer text (success) or Claude's own error text; null when absent. */
      result: string | null;
      /** Error messages of a failed run, e.g. "No conversation found with session ID: …". */
      errors: string[];
      sessionId: string | null;
    };

export function createLineSplitter(): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  function take(text: string): string[] {
    pending += text;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    return parts.map(trimCr).filter(notBlank);
  }

  return {
    push: (chunk) => take(typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk))),
    end() {
      const lines = take(decoder.end());
      const last = trimCr(pending);
      pending = "";
      return notBlank(last) ? [...lines, last] : lines;
    },
  };
}

/** Classifies one stdout line; null for everything snapsolve does not act on. */
export function parseEvent(line: string): StreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  switch (raw.type) {
    case "stream_event":
      return streamEvent(raw.event);
    case "system":
      if (raw.subtype === "thinking_tokens") return { type: "thinking" };
      if (raw.subtype === "init" && typeof raw.session_id === "string") {
        return { type: "init", sessionId: raw.session_id, apiKeySource: str(raw.apiKeySource), model: str(raw.model) };
      }
      return null;
    case "rate_limit_event":
      return rateLimit(raw.rate_limit_info);
    case "result":
      return {
        type: "result",
        isError: typeof raw.is_error === "boolean" ? raw.is_error : raw.subtype !== "success",
        subtype: str(raw.subtype),
        durationMs: num(raw.duration_ms),
        durationApiMs: num(raw.duration_api_ms),
        ttftMs: num(raw.ttft_ms),
        totalCostUsd: num(raw.total_cost_usd),
        result: str(raw.result),
        errors: Array.isArray(raw.errors) ? raw.errors.filter((e): e is string => typeof e === "string") : [],
        sessionId: str(raw.session_id),
      };
    default:
      // Includes `assistant`: the full message repeats the streamed text deltas.
      return null;
  }
}

function streamEvent(event: unknown): StreamEvent | null {
  if (!isRecord(event)) return null;
  if (event.type === "content_block_delta") {
    const delta = event.delta;
    return isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string"
      ? { type: "text", text: delta.text }
      : null;
  }
  if (event.type === "content_block_start") {
    const block = event.content_block;
    return isRecord(block) && (block.type === "thinking" || block.type === "redacted_thinking") ? { type: "thinking" } : null;
  }
  return null;
}

function rateLimit(info: unknown): StreamEvent | null {
  if (!isRecord(info) || typeof info.status !== "string") return null;
  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  return {
    type: "rateLimit",
    status: info.status,
    resetsAt: num(info.resetsAt),
    rateLimitType: str(info.rateLimitType),
    fiveHour: rateWindow(windows.five_hour),
    sevenDay: rateWindow(windows.seven_day),
  };
}

function rateWindow(w: unknown): RateWindow | null {
  if (!isRecord(w)) return null;
  const utilization = num(w.utilization);
  return utilization === null ? null : { utilization, resetsAt: num(w.resetsAt) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function notBlank(line: string): boolean {
  return line.trim() !== "";
}
