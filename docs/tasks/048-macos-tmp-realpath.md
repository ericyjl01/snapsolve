# 048 · runner integration: macOS /var → /private/var cwd mismatch

## Objective
Make `test/integration/runner.integration.test.ts` pass on macOS, where `os.tmpdir()` lives under `/var/folders/…` and `/var` is a symlink to `/private/var`, so the fake claude's `process.cwd()` is the resolved path while the test compares it to the unresolved one.

## Scope
In:  the integration test's temp root is resolved with `realpath` right after `mkdtemp` (so `dataDir` and every path derived from it are canonical), or the cwd assertion compares realpaths — whichever keeps every other assertion in the file meaningful.
Out: runner/store code (the runner passes `cwd` correctly; only the comparison is wrong). Windows behavior must not change.

## Done when
- [ ] `npx vitest run test/integration/runner.integration.test.ts` passes on macOS
- [ ] full suite `npx vitest run --project unit` has no failure from this file

## Tests
Command: `npx vitest run test/integration/runner.integration.test.ts`
- "ok: deltas in order, done carries the result fields, the transcript moves into the thread dir" — already fails on macOS as written (Expected `/var/folders/…/data/sessions`, Received `/private/var/folders/…`); this existing failure is the red. The `<id>: tests` commit may add an explicit assertion that `start.cwd` equals `realpath(path.join(dataDir, "sessions"))`, which must fail before the fix.
- Reviewer check: the fix must not hide a real runner bug — `findTranscript` scans project dirs by mtime, not by the encoded cwd name, so a symlinked data dir does not change which transcript is adopted.

## Spec refs
docs/tasks/015 (first full run on a Mac, 2026-10-17).

## Notes
Found 2026-10-17 on the first macOS `npm test` run (015 precondition ok, e2e green; only this and 049 failed).
