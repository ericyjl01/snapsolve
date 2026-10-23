# 042 · Runner: drop claude output that arrives after a SIGKILL-settled turn

## Objective
A timed-out turn whose claude ignores the first kill is settled right after `child.kill("SIGKILL")` (018), before the process closes. Output still in the pipe is delivered after that: `src/main/runner.ts`'s stdout handler and the `close` handler's `splitter.end()` keep calling `handle()`, which emits `delta`/`thinking`/`init`/`rateLimit` events for the thread after its `timeout` error event and mutates the already-resolved attempt. Seen while writing 034 (2026-10-15): a text line written after the settle was emitted as `{"type":"delta","text":"LATE"}`. In practice this is the macOS path (on Windows `kill()` terminates at once, so `close` settles the turn first).

## Scope
In:  `src/main/runner.ts`: once a turn has settled, its child's later stdout lines and its `close` flush emit no events and do not change the resolved attempt; `test/unit/runner.test.ts`.
Out: the timeout and SIGKILL rules themselves (018); renderer handling of deltas (009).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/runner.test.ts`
- a child that never closes writes a text delta line after the SIGKILL settle → no event after the turn's `timeout` error event; the outcome stays `timeout`.
- the same child then closes with a partial (unterminated) line buffered → the `close` flush emits nothing either.
- a normal turn (close settles it) is unchanged: every delta before the close is emitted, in order (existing spawn tests stay green).

## Spec refs
SPEC §3.5; tasks 018, 034.

## Notes
Found while writing 034 (2026-10-15). Backlog: low impact (late output arrives within milliseconds of the SIGKILL, long before a user could retry), but the panel would see a delta after an error.
