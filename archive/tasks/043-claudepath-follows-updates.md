# 043 · macOS claudePath follows Claude Code updates (no realpath pin)

## Objective
`writeClaudePath` (`plugin/skills/snapsolve/scripts/steps.mjs`) stores `realpath(claude)` (DESIGN §4.2 step 4). With Claude Code's native installer on macOS, `~/.local/bin/claude` is a symlink to a version-specific binary under `~/.local/share/claude/versions/`, so config.json gets pinned to one Claude Code version; after an auto-update prunes it, every turn fails `claudeNotFound` until `/snapsolve install` runs again. (From the 2026-10-15 /code-review, finding 4; Eric: "do 4".)

## Scope
In:  `writeClaudePath` takes `platform` (ARCHITECTURE Conventions); on darwin it stores the absolute resolved path as found (the symlink), after `realpath` confirms it resolves; win32 unchanged (realpath). `commands.mjs` passes `ctx.platform`. DESIGN §4.2 step 4 gets a note; DECISIONS row.
Out: Windows behavior; how `resolveClaude` finds claude.

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/installer-steps.test.ts`
- darwin: claude found at `/Users/e/.local/bin/claude`, injected realpath → `/Users/e/.local/share/claude/versions/2.1.299` → config.json `claudePath` is `/Users/e/.local/bin/claude`; the returned claudePath is the same.
- darwin: realpath fails (dangling symlink) → the existing "claude not found at …" error; config untouched.
- win32: the stored path is still the realpath (unchanged).
- darwin: an existing config.json keeps its other keys; a non-object config.json warning names the symlink path.
- commands: install passes the platform to writeClaudePath (darwin fake steps see `platform: "darwin"`).

## Spec refs
DESIGN §4.2 step 4; SPEC §6 (`claudePath`).

## Notes
Filed 2026-10-15 from /code-review all.
