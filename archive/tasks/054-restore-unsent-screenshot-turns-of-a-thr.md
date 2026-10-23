# 054 · Restore unsent screenshot turns of a thread that crashed while queued

## Objective
The runner appends a turn's user turn only when the turn starts. A capture or append that was still queued when the app quit has its `NNN.png` on disk but no screenshot turn. 052's startup pass marks such a thread `error`, but `retryTarget` finds nothing to re-run, so Retry does nothing (logged `app.retryNothing`). A queued follow-up's text is not saved anywhere and is lost. Found while building 052 (2026-10-17).

## Scope
In:  `src/main/app.ts` `recoverBusyThreads`: for a busy thread, append a screenshot user turn for each saved `NNN.png` after the highest one its turns reference, in order, before marking it `error`; `test/unit/app.test.ts`.
Out: persisting queued follow-up text; runner behavior for live turns.

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/app.test.ts`
- a `queued` thread with 001.png and no turns → one screenshot turn 001.png, status error, Retry queues `{ kind: "retry" }`.
- a `queued` thread with an answered 001.png turn and an unreferenced 002.png → a 002.png screenshot turn appended; Retry re-runs it as an append.
- a busy thread with no unreferenced screenshots → turns unchanged.
- a gap (003.png present, 002.png missing) → only consecutive files after the highest referenced one are added.

## Spec refs
SPEC §3.5, §5.1.

## Notes
