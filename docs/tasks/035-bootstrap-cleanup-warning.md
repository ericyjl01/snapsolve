# 035 · Installer steps: report bootstrap cleanup warning; test default isRunning

## Objective
Two gaps the 023 review found in `plugin/skills/snapsolve/scripts/steps.mjs`: `packageBootstrap` drops the "could not remove the previous copy" warning that `swapIn` returns (so a ~250 MB `.snapsolve-old-<id>` dir can stay in `%LOCALAPPDATA%\Programs` without a word), and `quitAndWait`'s default `isRunning` (tasklist on the exe's basename) is never exercised.

## Scope
In:  `packageBootstrap` returns `{ exe, warnings }` when the old launcher could not be removed (same shape as `stageVersion`: `warnings` present only when non-empty); a test seam for the removal (injected `rm` or equivalent) so the failure is testable; tests for `quitAndWait` without `isRunning` that prove it calls `tasklist` with the exe's basename through the injected `exec`.
Out: anything 024 does with the warnings (it prints them).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/installer-steps.test.ts`
- packageBootstrap with an existing Programs dir whose removal fails after the swap → resolves with `warnings` naming the leftover dir; the new launcher is in place.
- packageBootstrap whose removal succeeds → result has no `warnings` key (existing exact-shape test keeps passing).
- quitAndWait without `isRunning`: the injected `exec` sees `tasklist /FI "IMAGENAME eq snapsolve.exe" …` for `C:\P\snapsolve.exe` (basename, not the full path), and `--quit` is sent only when tasklist lists it.

## Spec refs
DESIGN §4.2 step 3, §4.3; DECISIONS 2026-10-14 (023 rows).

## Notes
From the 023 review (2026-10-14), recorded as non-blocking.
