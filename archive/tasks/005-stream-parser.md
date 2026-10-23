# 005 · Stream-json parser

## Objective
Pure parsing of `claude -p --output-format stream-json` output per SPEC §3.3.

## Scope
In:  `src/main/stream.ts`: `createLineSplitter()` (chunk reassembly, CRLF, final flush, skip blanks), `parseEvent(line)` → `text | thinking | init | rateLimit | result | null`; recorded fixtures `test/fixtures/stream/*.jsonl` captured once from real `claude` (sonnet/low tiny prompt; an image prompt; an opus/high prompt for thinking events; a `--resume` of a nonexistent session for the error result).
Out: spawning (006).

## Done when
- [ ] task tests pass; fixtures committed and free of email/org identifiers (`grep -i -E "@|orgId|email" test/fixtures/stream/` prints nothing sensitive)

## Tests
Command: `npx vitest run test/unit/stream.test.ts`
- splitter: a line split across 3 chunks is reassembled; CRLF stripped; several lines in one chunk; trailing line flushed on end; empty lines skipped.
- parseEvent: `content_block_delta`/`text_delta` → text; thinking `content_block_start` and `system/thinking_tokens` → thinking; `system/init` → sessionId + apiKeySource; `rate_limit_event` → five_hour/seven_day utilization, status, resetsAt; `result` success → isError false + durations + ttft + cost; error result fixture ("No conversation found") → isError true; unknown type → null; malformed JSON → null without throwing; the full `assistant` message is ignored (no double text).
- fixture replay: concatenated text events of each fixture equal its `result.result`.

## Spec refs
SPEC §3.3.

## Notes
