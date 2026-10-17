# 050 · Retry re-runs the failed turn without a duplicate user turn

## Objective
SPEC §3.5 / §7.1 Retry: 009's `retry(threadId)` (`src/main/app.ts`) re-enqueues the errored thread's last user request (follow-up text, or the screenshot as `new`/`append`). `runner.run` appends a user turn for every request, so each Retry adds a second copy of that user turn to thread.json, and a resume-fallback turn then sends the retried screenshot twice (`screenshotFiles` lists it twice). Found while building 009 (2026-10-17).

## Scope
In:  `src/main/runner.ts` a retry request (e.g. `{ kind: "retry" }` or a `retry: true` flag) that re-runs the last user turn without appending it again; `src/main/app.ts` `retry` uses it; `test/unit/runner.test.ts`, `test/unit/app.test.ts`.
Out: the Retry button UI (009); error messages (011).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/runner.test.ts test/unit/app.test.ts`
- a failed follow-up retried → thread.json has the follow-up's user turn once, then the errored answer, then the new answer.
- a failed first screenshot retried → one screenshot turn; the fallback/resume message carries the image once.
- retry of a thread whose last turn is not an errored answer → nothing queued.

## Spec refs
SPEC §3.4, §3.5, §7.1.

## Notes
