# 016 · Retry atomic renames on transient Windows EPERM/EBUSY/EACCES

## Objective
A thread.json update or transcript adoption survives another process (Defender, the search indexer) holding the target file for a moment.

## Scope
In:  `src/main/store.ts` — the rename in `writeJsonAtomic` and in `adoptTranscript` retries EPERM, EBUSY and EACCES a bounded number of times (total wait ≤ ~200 ms) before failing; other codes fail at once.
Out: retrying reads; config.ts (it never renames over an existing file).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/store.test.ts`
- rename fails EBUSY twice then succeeds → the write lands, no temp file left.
- rename fails EPERM on every try → rejects after the bound, previous content intact, temp removed.
- ENOSPC is not retried (one rename call).
- adoptTranscript: a transient EBUSY on the rename still adopts.

## Spec refs
SPEC §5.1 (atomic writes); DESIGN §10 risk 6 (Defender on this PC).

## Notes
From 004's implementation: renames are attempted once today.
004's test "is the store's thread.json writer: a failed update keeps the thread as it was" injects a single EBUSY; with retries it must inject a non-retried code (ENOSPC) instead — a genuine test fix, say so in the commit.
