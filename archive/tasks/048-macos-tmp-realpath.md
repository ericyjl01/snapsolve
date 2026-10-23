# 048 · macOS portability: runner integration cwd realpath + realSteps claude.exe basename

## Objective
Make the unit-project suite green on macOS. The first macOS run (2026-10-17) failed two tests:
1. `test/integration/runner.integration.test.ts` "ok: …": `os.tmpdir()` is under `/var/folders/…` and `/var` links to `/private/var`, so the fake claude's `process.cwd()` is the resolved path while the test compares it to the unresolved one.
2. `test/unit/installer-commands.test.ts` "SNAPSOLVE_TEST=1 → claude.exe (any case)…": `realSteps.mjs` matches `path.basename(command)`; on POSIX `path.basename("C:\\…\\CLAUDE.EXE")` is the whole string, so the hook never fires.
(049 was folded in here: each failure broke the other's full-suite close gate.)

## Scope
In:  the runner integration test's temp root is resolved with `realpath` right after `mkdtemp`; `plugin/skills/snapsolve/scripts/realSteps.mjs` matches with `path.win32.basename` (splits on `\` and `/`), keeping the case-insensitive `claude.exe` rule and an accurate doc comment.
Out: runner/store code (the runner passes `cwd` correctly); making the hook match a POSIX `claude` binary (the installer e2e is `runIf(win32)`); steps.mjs, commands.mjs. Windows behavior must not change.

## Done when
- [ ] `npx vitest run test/integration/runner.integration.test.ts test/unit/installer-commands.test.ts` passes on macOS
- [ ] full suite `npx vitest run --project unit` passes on macOS

## Tests
Command: `npx vitest run test/integration/runner.integration.test.ts test/unit/installer-commands.test.ts`
- existing runner "ok: …" and installer "SNAPSOLVE_TEST=1 → claude.exe (any case)…" — both fail on macOS today (the red).
- added (runner): a data dir reached through a symlink — claude's cwd realpath equals the sessions dir realpath; the transcript is adopted into `<dataDir>/threads/<id>/` and lands in the real dir; nothing left in projects.
- added (installer): with SNAPSOLVE_TEST=1, backslash, forward-slash, mixed-case and `/c/…` paths ending in `claude.exe` run the fake; `claude.exe.bak`, `notclaude.exe`, `/usr/local/bin/claude` and bare `claude` run as themselves.
- Reviewer check: the realpath fix must not hide a runner bug — `findTranscript` scans project dirs by mtime, not by the encoded cwd name.

## Spec refs
docs/tasks/015 (first full run on a Mac); docs/tasks/036 (CLI hook wiring).

## Notes
Found 2026-10-17 on the first macOS `npm test` run (015 precondition ok, e2e green; only these two failed).
