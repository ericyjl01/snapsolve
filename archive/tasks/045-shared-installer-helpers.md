# 045 · commands.mjs reuses steps.mjs helpers (rename retry, readJson, exists)

## Objective
`commands.mjs` re-implements helpers `steps.mjs` already has: the rename retry (inlined in `writeState` with the same delay table), `readJson` and `exists` (lstat in commands, stat in steps). Two copies drift. (From the 2026-10-15 /code-review, finding 9; Eric: "do 9".)

## Scope
In:  `steps.mjs` exports `renameRetrying`, `readJson`, `exists` (follows links) and `linkExists` (lstat: a dangling link counts); `commands.mjs` imports them and drops its copies. Call sites keep their meaning: uninstall's removal targets use `linkExists` (a dangling `current` junction or .app symlink is still removed); exe, config and data-dir checks use `exists`.
Out: `compareVersions` (044); any other behavior change.

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes; `commands.mjs` defines no rename loop, `readJson` or `exists` of its own

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts test/unit/installer-steps.test.ts`
- uninstall with a dangling `current` junction (its target dir deleted) → the junction is removed and reported.
- start with an exe path that is a dangling symlink/junction → "not installed: run /snapsolve install" (exists follows links).
- writeState retries a transient EPERM rename (injected) and still writes install.json; a non-transient error propagates.
- steps exports: `linkExists` true for a dangling link, `exists` false for it.

## Spec refs
ARCHITECTURE Conventions; DESIGN §4.

## Notes
Filed 2026-10-15 from /code-review all. Depends on 044 (both move helpers into steps.mjs exports).
