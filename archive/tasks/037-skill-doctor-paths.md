# 037 · SKILL.md doctor: name the data folder's log and config paths

## Objective
The 025 review found that SKILL.md's doctor section sends Claude to "`logs\snapsolve.log` in the folder the output names" and to "their" hotkey, but a clean `doctor` run prints neither the data folder nor the hotkey or config path (the only folder it names is the launcher's, `%LOCALAPPDATA%\Programs\snapsolve`). Name the real locations so Claude looks in the right place.

## Scope
In:  `plugin/skills/snapsolve/SKILL.md` doctor section: the log is `%LOCALAPPDATA%\snapsolve\logs\snapsolve.log`, the config (with `hotkeys.capture`) is `%LOCALAPPDATA%\snapsolve\config.json`; the hotkey question uses the configured `hotkeys.capture` when Claude has read it. `test/unit/skill.test.ts` additions.
Out: making `doctor` print the data folder or hotkey (installer behavior; a separate task if wanted).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/skill.test.ts`
- doctor section contains `%LOCALAPPDATA%\snapsolve\logs\snapsolve.log` and `%LOCALAPPDATA%\snapsolve\config.json`, and no longer says "the folder the output names" for the log.
- the paths agree with the app's data dir rules (`resolveDataDir("win32", { LOCALAPPDATA: "%LOCALAPPDATA%" }, …)` + `logs/snapsolve.log` / `config.json` from `dataPaths`).
- existing hygiene test still passes (no `C:\Users`, `/Users/`).

## Spec refs
SPEC §5.1, §8.1; DESIGN §4.2 step 7.

## Notes
From the 025 review (2026-10-14), recorded as non-blocking.
