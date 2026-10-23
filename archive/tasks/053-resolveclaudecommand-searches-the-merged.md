# 053 · resolveClaudeCommand searches the merged login PATH on macOS

## Objective
SPEC §6.1 / §9.1: on macOS `main.ts` calls `resolveClaudeCommand` with `process.env`, so an app started from Finder (launchd's minimal PATH) looks for `claude` only there and in `~/.local/bin`, then falls back to a bare `claude` that the spawn resolves through the merged login PATH (030). Found by the 030 reviewer (2026-10-17). It works, but the lookup and the spawn should use the same PATH, so the resolved path is the one that runs.

## Scope
In:  `src/main/main.ts` passes `startup.env` (the merged PATH from `darwinStartup`) to `resolveClaudeCommand`; a test in `test/unit/app.test.ts` that a claude found only in a login-PATH dir resolves to that absolute path.
Out: the installer's claudePath (043); Windows lookup.

## Done when
- [ ] `npx vitest run test/unit/app.test.ts` passes

## Tests
Command: `npx vitest run test/unit/app.test.ts`
- darwin, env PATH = merged PATH containing `/opt/homebrew/bin` with claude there, not in `~/.local/bin` → resolves `/opt/homebrew/bin/claude` (absolute), not the bare `claude`.
- a configured `claudePath` still wins over the merged PATH.

## Spec refs
SPEC §6.1, §9.1.

## Notes
