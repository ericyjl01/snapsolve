# 036 · Installer: restart the app after a failed update; test hooks inert

## Objective
Two gaps the 024 review found in `plugin/skills/snapsolve/scripts/`: when `update` (or a reinstall) has quit the running app and a later step fails (stage, current, package), the app stays stopped and the output does not say so; and nothing proves the CLI's `SNAPSOLVE_TEST_*` hooks are inert without `SNAPSOLVE_TEST=1`.

## Scope
In:  `commands.mjs`: after a failure that follows a successful quit, relaunch the previously installed exe when it still exists (its `current` link was not moved yet, or was moved back) and add a `warn:` line saying the old version was restarted; when it cannot be restarted, the `fail:` line says to run `/snapsolve start`. `snapsolve.mjs`: hook wiring factored so it is testable (e.g. exported `realSteps(env)` from a module the CLI imports), plus a test that without `SNAPSOLVE_TEST=1` the claude exec, launch and isRunning are the real ones even when the `SNAPSOLVE_TEST_*` variables are set.
Out: rolling `current` back after a successful `pointCurrent` (the old version dir is kept; a later task if needed).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts`
- update: quit ok, stage throws → fail: line with the stage error, launch called with the old exe, a warn: line about the restart; exit 1.
- update: quit ok, stage throws, old exe gone → no launch; the fail: text names `/snapsolve start`.
- install over an existing install: same two cases.
- update: quit itself fails → no relaunch attempt (the app is still running).
- hooks: `SNAPSOLVE_TEST_CLAUDE` / `SNAPSOLVE_TEST_LAUNCH_LOG` set without `SNAPSOLVE_TEST=1` → claude.exe runs as itself, launch spawns, isRunning uses tasklist (via injected fakes); with `SNAPSOLVE_TEST=1` → the hooks apply.

## Spec refs
DESIGN §4.3; DECISIONS 2026-10-14 (024 rows).

## Notes
From the 024 review (2026-10-14), recorded as non-blocking.
