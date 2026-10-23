# 051 · 7th append seeds the new thread with the previous thread's last answer

## Objective
SPEC §2.3: "The 7th append starts a new thread seeded with the previous thread's last answer as text; the card says so." 009's `onAppend` (`src/main/app.ts`) starts a plain new thread at the cap: the runner has no way to put the previous answer into the first message, and the card has no note. Found while building 009 (2026-10-17).

## Scope
In:  `src/main/runner.ts` a seeded first turn (previous answer text before the image's question); `src/main/app.ts` `onAppend` at the cap passes the previous thread's last answer; a thread/turn note the card shows (`src/shared/types.ts`, `src/renderer/renderer.ts`); tests.
Out: the append hotkey itself (010).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/runner.test.ts test/unit/app.test.ts`
- append on a thread at `maxScreenshotsPerThread` → a new thread whose first stdin message has the image and the previous thread's last answer text.
- that thread records a note the card shows ("continued from the previous thread").
- a previous thread with no successful answer → plain new thread, no seed text.

## Spec refs
SPEC §2.3.

## Notes
