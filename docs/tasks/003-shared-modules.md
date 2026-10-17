# 003 · Shared modules: paths, config, log, errors, ipc, types

## Objective
The canonical shared modules every later task imports.

## Scope
In:  `src/main/paths.ts` (`resolveDataDir(platform, env, home)`: `SNAPSOLVE_DATA_DIR` override → win32 `%LOCALAPPDATA%\snapsolve`, darwin `~/Library/Application Support/snapsolve`; `dataPaths(dir)` → config/threads/sessions/logs/app; `ensureDirs`), `src/main/config.ts` (DEFAULTS per SPEC §6.1; `loadConfig(path)`: create with defaults if missing; per-field validation; invalid/unknown → default + warning; never rewrites an existing file), `src/main/log.ts` (`createLogger(file)`: JSON lines `ts, level, event, …`; redacts `data, image, base64, text, prompt, answer, email` keys; rotates at 5 MB to `.1`; creates its dir; never throws), `src/shared/errors.ts` (`SnapsolveError` with `kind`; `userMessage(kind)` with SPEC §7.1 texts), `src/shared/ipc.ts`, `src/shared/types.ts`.
Out: store, runner, UI.

## Done when
- [ ] task tests pass; `npm run build` exits 0
- [ ] `grep -rn "process.platform" src/` matches only `paths.ts`, `capture.ts`, `panel.ts`, `main.ts`

## Tests
Command: `npx vitest run test/unit/paths.test.ts test/unit/config.test.ts test/unit/log.test.ts test/unit/errors.test.ts`
- paths: override wins; win32 path under LOCALAPPDATA; darwin path under Library/Application Support; win32 without LOCALAPPDATA → error; unsupported platform → error; `ensureDirs` idempotent.
- config: missing file → written with defaults, returned; valid file honored; wrong types (`model: 5`, `maxConcurrent: 0`, `timeoutSec: -1`, bad accelerator) → defaults + one warning each, file untouched; malformed JSON → defaults + warning, file untouched; unknown keys → warning; `autoHideSec` 0 and `allowApiKey` false by default.
- log: one JSON line per call with ts/level/event; sensitive keys redacted (nested too); rotation at the size limit; missing dir created; write errors swallowed after one stderr note.
- errors: every kind has a non-empty message; `claudeNotFound` text is exactly "Claude Code not found. Run /snapsolve install."; `SnapsolveError` keeps `kind` and `cause`.

## Spec refs
SPEC §5.1, §6.1, §7.1; ARCHITECTURE `## Canonical locations`, `## Conventions`.

## Notes
