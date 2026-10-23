# 052 · Threads left busy by an earlier run are marked errored at startup

## Objective
A thread whose status is `new`, `queued` or `running` when the app quits or crashes keeps that status in thread.json. At the next start the panel lists it as busy ("Thinking…") forever, with no Retry. At startup, before the first listing, such threads should become `error` with a Retry. Found while building 009 (2026-10-17).

## Scope
In:  `src/main/app.ts` (startup pass over `store.listThreads()`: busy → `store.updateThread(id, { status: "error" })`, logged), wired from `src/main/main.ts` before the panel lists threads; `test/unit/app.test.ts`.
Out: runner behavior for live turns.

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/app.test.ts`
- threads with status new/queued/running on disk at startup → status error afterwards; done/error threads untouched.
- such a thread then accepts Retry (its last user request is re-queued).
- unreadable threads are still skipped, never rewritten.

## Spec refs
SPEC §3.5, §4.2, §5.1.

## Notes
