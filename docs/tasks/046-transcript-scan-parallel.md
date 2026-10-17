# 046 · findTranscript: stat project dirs in parallel

## Objective
`findTranscript` (`src/main/store.ts`) stats `<dir>/<sid>.jsonl` in every directory under `~/.claude/projects`, one after another. A heavy Claude Code user has hundreds of project dirs, so every first turn's adoption waits on hundreds of serial stats. (From the 2026-10-15 /code-review, finding 10; Eric: "do 10".)

## Scope
In:  the stats run concurrently with a bound (at most 32 in flight); same result: the newest-mtime match, the duplicates warning, non-directories skipped, missing files ignored. A `stat` dependency in `StoreDeps` (defaults to `fs/promises` stat) so the test can observe concurrency.
Out: guessing claude's project-dir name for the cwd; adoption rules.

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/store.test.ts`
- 200 project dirs, the transcript in one → found; with an injected delayed stat, more than one stat is in flight at once and never more than 32.
- two matches → the newer mtime wins and `store.transcriptDuplicates` is logged (unchanged).
- a file (not a dir) in projects, and dirs without the transcript → ignored; no match → transcript marked missing (unchanged).
- projects dir missing → null without a warning; unreadable → `store.projectsUnreadable` (unchanged).

## Spec refs
SPEC §3.4 (transcript adoption).

## Notes
Filed 2026-10-15 from /code-review all.
