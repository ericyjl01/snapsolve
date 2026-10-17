# 049 · realSteps test hook: match claude.exe across path styles on POSIX

## Objective
`plugin/skills/snapsolve/scripts/realSteps.mjs:20` decides whether a command is claude.exe with `path.basename(command)`. On macOS/Linux `path.basename("C:\\Users\\e\\.local\\bin\\CLAUDE.EXE")` returns the whole string (backslash is not a separator), so the SNAPSOLVE_TEST hook does not fire and the unit test "SNAPSOLVE_TEST=1 → claude.exe (any case) runs the fake script with node…" fails on a Mac.

## Scope
In:  realSteps.mjs matches the basename with `path.win32.basename` (splits on both `\` and `/`), keeping the case-insensitive `claude.exe` rule; its doc comment stays accurate.
Out: making the hook match a POSIX `claude` binary (the installer end-to-end test is `runIf(win32)`; a macOS installer e2e is a separate decision). steps.mjs, commands.mjs.

## Done when
- [ ] `npx vitest run test/unit/installer-commands.test.ts` passes on macOS
- [ ] full suite `npx vitest run --project unit` passes on macOS

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts`
- existing "SNAPSOLVE_TEST=1 → claude.exe (any case) runs the fake script with node…" — fails on macOS today (this is the red).
- add: a forward-slash path ending in `claude.exe` (e.g. `/c/Users/e/.local/bin/claude.exe`) also runs the fake; `claude.exe.bak`, `notclaude.exe` and a bare `claude` run as themselves.

## Spec refs
docs/tasks/036 (CLI hook wiring); docs/tasks/015 (first full run on a Mac, 2026-10-17).

## Notes
Found 2026-10-17 on the first macOS `npm test` run, together with 048.
