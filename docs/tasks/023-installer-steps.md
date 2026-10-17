# 023 · Installer steps (Windows)

## Objective
DESIGN §4.2–4.3 as small, testable steps the commands (024) compose: preflight, stage a version, point `current` at it, package the bootstrap into `%LOCALAPPDATA%\Programs\snapsolve` with a Start-menu shortcut, write `claudePath`, launch, quit-and-wait, and the Defender ASR check.

## Scope
In:  `plugin/skills/snapsolve/scripts/steps.mjs` (plain Node ESM ≥ 20, built-ins only — it runs from the plugin before anything is installed). Every step takes its dependencies (`platform`, `env`, `home`, `exec`/`spawn`, `now`, `sleep`, packager loader) so tests run with fakes and temp dirs:
- `preflight`: platform (win32 ok; darwin → "macOS support comes in M3"; else unsupported), Node major ≥ 20, `claude --version`, `claude auth status` JSON (`loggedIn`, `authMethod`, `subscriptionType`); API-key auth → warning, not failure.
- `stageVersion`: copy the plugin's `app/` to `<data>/app/<version>/`, `npm ci --omit=dev` there; on failure remove the partial dir and leave `current` untouched.
- `pointCurrent`: `<data>/app/current` → version dir (junction on win32, symlink on darwin); never deletes a real directory in its place.
- `packageBootstrap`: `@electron/packager` loaded from the staged version's `node_modules`, options `{ dir: <version>/bootstrap, name: "snapsolve", appBundleId: "com.snapsolve.app", electronVersion: <exact electron from app/package.json devDependencies>, icon (when present), overwrite: true }`; output replaces `%LOCALAPPDATA%\Programs\snapsolve\`; Start-menu shortcut `%APPDATA%\Microsoft\Windows\Start Menu\Programs\snapsolve.lnk` via PowerShell `WScript.Shell`.
- `writeClaudePath`: `config.json` missing → full defaults + `claudePath` (realpath of the resolved `claude`); present → only `claudePath` changes (atomic temp + rename); invalid JSON → untouched, warning.
- `launch`: detached, env without `CLAUDECODE`/`CLAUDE_CODE_*`; `quitAndWait`: `<exe> --quit`, poll up to 5 s for exit; `asrCheck`: run `<exe> --smoke` → `ok` / `blocked` (spawn `EPERM`) / `failed`.
ARCHITECTURE module map: installer scripts under `plugin/skills/snapsolve/scripts/` (Eric's marketplace convention) + DECISIONS row; `test/unit/installer-steps.test.ts`.
Out: command flows and CLI (024), SKILL.md (025), macOS bundle/codesign (M3), running a real install (026).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/installer-steps.test.ts`
- preflight: win32 + Node 22.12.0 + logged-in claude → ok; darwin → M3 message; linux → unsupported; Node 22.11.0 and Node 20 → fail with the `winget install OpenJS.NodeJS.LTS` hint (minimum 22.12, DECISIONS 2026-10-14); `claude` ENOENT → fails naming Claude Code; `loggedIn: false` → fails with the login hint; API-key `authMethod` → ok plus a billing warning; non-JSON auth output → fails, quoting the output.
- stageVersion copies every payload file to `<data>/app/<version>/` and runs `npm ci --omit=dev` with that cwd; npm failure → error with npm's last lines, version dir removed, `current` still points at the previous version.
- pointCurrent with real junctions in a temp dir (win32): new install creates it; switching versions repoints it and `current/main.js` reads the new file; a real directory named `current` → error, nothing deleted. darwin branch → symlink via the injected fs.
- packageBootstrap passes exactly the options above (electronVersion read from `app/package.json`; a range like `^44` → error), replaces an existing Programs dir, and the shortcut script targets the exe with paths containing spaces and an apostrophe quoted correctly.
- writeClaudePath: missing config → keys equal `DEFAULTS` from `src/main/config.ts` with `claudePath` set (parity test), and `loadConfig` reads it with no warnings; existing config with user values → only `claudePath` differs; invalid JSON → file byte-identical, warning returned.
- launch strips `CLAUDECODE` and `CLAUDE_CODE_*` from the child env and detaches; quitAndWait returns once the process is gone, errors after 5 s (fake clock) naming the exe.
- asrCheck: spawn error `EPERM` → `blocked`; exit 0 with `snapsolve smoke ok` → `ok`; other exit → `failed` with output.

## Spec refs
SPEC §8.1; DESIGN §4.2, §4.3, §10 risk 6 (Detect), C4; DECISIONS 2026-10-14 (020: unsigned, doctor runs the ASR check).

## Notes
`--smoke` exists in `src/main/main.ts` today; `--quit` arrives with 010 (single-instance lock) — the steps only invoke them, and the fakes stand in until then. Env vars `LOCALAPPDATA`/`APPDATA` are the only directory inputs, so tests point them at temp dirs.
