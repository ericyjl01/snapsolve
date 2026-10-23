# 041 · Restart after a failed update: name /snapsolve install when the old exe is gone

## Objective
The 036 review found that when an install/update fails after the quit and the previous exe is gone, `afterQuit` (`plugin/skills/snapsolve/scripts/commands.mjs`) says "snapsolve is not running: run /snapsolve start", but `start` with no exe answers "not installed: run /snapsolve install". The user should be sent straight to the command that works.

## Scope
In:  `afterQuit` in `commands.mjs`: exe gone → the fail: line names `/snapsolve install`; exe present but its launch failed → still `/snapsolve start`. Tests in `test/unit/installer-commands.test.ts` (the two 036 "old exe is gone" tests change their expected text, with this task as the justification).
Out: the restart rules themselves (DECISIONS 036).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts`
- update and install: stage throws, old exe gone → no launch; the fail: line names `/snapsolve install` and not `/snapsolve start`.
- relaunch denied (EPERM) → the ASR line and a fail: naming `/snapsolve start` (unchanged).

## Spec refs
DESIGN §4.3; DECISIONS 036.

## Notes
From the 036 review (2026-10-14), recorded as non-blocking.
