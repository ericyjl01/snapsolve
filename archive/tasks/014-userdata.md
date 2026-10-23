# 014 · Electron userData inside the data dir

## Objective
Electron's own files (GPU/shader caches, Local State, session storage) live in `<data>/electron`, never in Roaming `%APPDATA%\snapsolve`, which roaming profiles can sync.

## Scope
In:  `src/main/main.ts` sets `app.setPath('userData', path.join(<data dir from paths.ts>, 'electron'))` before `ready` in every mode (not only when `SNAPSOLVE_DATA_DIR` is set); DECISIONS row for the `electron` subfolder; remove the stale `%APPDATA%\snapsolve` left by earlier dev runs (Electron caches only — list its contents before deleting).
Out: any other path change.

## Done when
- [ ] task tests pass; `npm test` passes
- [ ] after `npm start` (closed via the tray or Task Manager), `%APPDATA%\snapsolve` does not exist and `%LOCALAPPDATA%\snapsolve\electron` does

## Tests
Command: `npx vitest run test/e2e/userdata.e2e.test.ts`
- with `SNAPSOLVE_DATA_DIR=<tmp>`: `app.getPath('userData')` is `<tmp>/electron` and that directory exists after launch.
- without the override, `LOCALAPPDATA=<tmp2>`: `app.getPath('userData')` is `<tmp2>/snapsolve/electron`.
- `userData` is never under `app.getPath('appData')` (Roaming) in either case.

## Spec refs
SPEC §5.1; DESIGN.md C4.

## Notes
Found in review of 001: the default userData was `%APPDATA%\snapsolve` (Roaming).
