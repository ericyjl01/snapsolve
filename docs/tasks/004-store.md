# 004 · Thread store with owned transcripts

## Objective
Persist threads per SPEC §5.1 and own each thread's Claude transcript per §3.4.

## Scope
In:  `src/main/store.ts` `createStore({ dataDir, projectsDir, purge, log })`: `createThread({model, effort})` (UUID id + UUID sessionId, status `new`), `saveScreenshot(id, png)` (`001.png`, `002.png`, …), `appendTurn`, `updateThread`, `getThread(id)`, `listThreads()` (derived from `threads/*/thread.json`, newest first), `screenshotPath(id, n)`, `adoptTranscript(id, sid)`, `replaceSession(id, newSid)`, `clearHistory()`, `writeJsonAtomic`.
Out: spawning claude (`purge` is injected); IPC.

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/store.test.ts`
- createThread writes `thread.json` with UUID `id`, UUID `sessionId`, status `new`.
- saveScreenshot numbers files 001, 002, … and returns paths inside the thread dir.
- appendTurn order survives a reload by a fresh store instance.
- writeJsonAtomic: a failed write leaves the previous content intact; leftover `.tmp` files are ignored by listThreads.
- listThreads newest first; corrupt `thread.json` skipped and logged, directory not deleted; non-UUID directories ignored.
- getThread / screenshotPath reject `..`, non-UUID ids, and out-of-range `n`.
- adoptTranscript finds `<projectsDir>/*/<sid>.jsonl`, copies it byte-identical into the thread dir, deletes the original, sets `transcriptPath`; missing transcript → returns `{ ok: false }` and marks the thread, no throw.
- replaceSession swaps sessionId/transcriptPath and keeps turns.
- clearHistory removes `threads/` and calls `purge(sessionsDir)`; list is empty after; a purge failure is logged and returned but threads are still deleted.

## Spec refs
SPEC §3.4, §5.1.

## Notes
