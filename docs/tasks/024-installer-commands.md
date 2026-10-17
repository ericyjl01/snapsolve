# 024 · Installer commands and CLI

## Objective
`node snapsolve.mjs install|start|update|doctor|uninstall` on Windows: each command composes 023's steps per DESIGN §4.2–4.3 and prints short `ok:` / `warn:` / `fail:` lines the skill can relay.

## Scope
In:  `plugin/skills/snapsolve/scripts/commands.mjs` (flows, injected deps) and `plugin/skills/snapsolve/scripts/snapsolve.mjs` (CLI: argv → command, real deps, exit codes 0 ok / 1 failed / 2 usage). Install state in `<data>/app/install.json` (`version`, `electronVersion`, `exe`).
- `install`: preflight → stage → point current → package bootstrap (first install, or when the recorded Electron version differs) → claudePath → launch → print the active hotkey and the AltGr note.
- `start`: installed → launch; else fail "run /snapsolve install".
- `update`: not installed → fail; same version → "up to date", nothing touched; else quitAndWait → stage → point current → package only if Electron changed → relaunch; keeps the previous version dir, removes older ones.
- `uninstall [--purge]`: quitAndWait → remove `%LOCALAPPDATA%\Programs\snapsolve`, the shortcut and `<data>/app`; history, config and logs stay unless `--purge`, which removes the whole data dir.
- `doctor`: claude version, auth, Node, installed vs plugin version, exe present, ASR check (`blocked` → "Defender ASR blocks <exe>; ask IT for an exclusion for it", per DECISIONS 020), config `claudePath` exists; exit 1 if any `fail:`.
`test/unit/installer-commands.test.ts`, `test/integration/installer.integration.test.ts`.
Out: SKILL.md wording and prompts (025); macOS (M3); a real install (026).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts test/integration/installer.integration.test.ts`
Unit (fake steps, recording call order):
- install calls preflight → stage → current → package → claudePath → launch in that order and writes install.json; preflight failure → nothing staged; second install of the same version with the same Electron → no packaging.
- update: same version → no step runs; new version → quit before stage, package skipped when Electron unchanged and run when it changed; relaunch last; only current + previous version dirs remain; quit timeout → fail, nothing staged.
- uninstall keeps `threads/`, `config.json`, `logs/`; `--purge` removes the data dir; not installed → ok with "nothing to remove".
- doctor: all healthy → only `ok:` lines, exit 0; ASR `blocked` → `fail:` line naming the exe and the IT exclusion, exit 1; installed version older than the plugin → `warn:` suggesting `/snapsolve update`.
- start when not installed → fail with the install hint.
- CLI: unknown command or none → usage, exit 2; `--purge` accepted only by uninstall.
Integration (spawns `node snapsolve.mjs` with `LOCALAPPDATA`/`APPDATA` in temp dirs, fake `claude` and `npm` first on PATH; the fake `npm ci` writes a fake `@electron/packager` that writes a fake exe; launch replaced via a test-only env hook that is inert unless `SNAPSOLVE_TEST=1`):
- install → exe, shortcut, `current/main.js`, config with claudePath, install.json exist; doctor exits 0 except the ASR line (fake exe); update to a bumped payload version flips `current`; uninstall leaves history; uninstall `--purge` leaves no data dir. No files outside the temp dirs.

## Spec refs
SPEC §8.1, Milestones `### M2`; DESIGN §4.2, §4.3, §10 risk 6; DECISIONS 2026-10-14 (020).

## Notes
The skill (025) asks the user before `--purge`; the CLI itself never prompts (it runs under Claude's Bash tool).
