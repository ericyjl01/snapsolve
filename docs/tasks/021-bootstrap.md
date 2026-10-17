# 021 · Bootstrap launcher (boot.js)

## Objective
SPEC §8.1 / DESIGN §4.1: the packaged launcher contains only `boot.js` + `package.json`; `boot.js` finds the data dir per OS (C4) and runs `<data>/app/current/main.js`, so code updates never rebuild the packaged app.

## Scope
In:  `bootstrap/boot.js` (CommonJS, Node built-ins + `electron` only): pure `resolveEntry(platform, env, home)` with the same rules as `src/main/paths.ts` (`SNAPSOLVE_DATA_DIR` absolute override, win32 `%LOCALAPPDATA%\snapsolve`, darwin `~/Library/Application Support/snapsolve`; anything else throws instead of guessing) → `<data>/app/current/main.js`; `boot(deps)` (exists → require the entry; missing or throwing → native error box naming `/snapsolve install` and the path, exit 1); side effects only when run as Electron's main module. `bootstrap/package.json` (`name` and `productName` snapsolve, `main: "boot.js"`, private, no dependencies). `test/unit/boot.test.ts`. ARCHITECTURE module map already lists `bootstrap/`.
Out: packaging it (023), anything in `src/`, macOS-specific behavior beyond the darwin path (M3).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/boot.test.ts`
- `resolveEntry` win32 → `<LOCALAPPDATA>\snapsolve\app\current\main.js` (path.win32); darwin → `<home>/Library/Application Support/snapsolve/app/current/main.js` (path.posix).
- Parity with the app: for win32, darwin and an absolute `SNAPSOLVE_DATA_DIR`, `resolveEntry` equals `path.join(dataPaths(resolveDataDir(...)).app, "current", "main.js")` from `src/main/paths.ts` (catches drift between the two copies).
- Errors, no guessing: relative `SNAPSOLVE_DATA_DIR`, missing or relative `LOCALAPPDATA`, platform `linux` → throws with a message naming the bad value.
- `boot` with the entry present → `require` called once with the entry, no error box, no exit.
- `boot` with the entry missing → error box text contains `/snapsolve install` and the entry path; exit(1); `require` never called.
- `boot` when `require` throws → error box contains the error message; exit(1).
- Loading `boot.js` in plain Node (vitest) has no side effects: no exit, no Electron access.
- `boot.js` requires only `path`, `fs`, `os` and `electron` (static scan) and `bootstrap/package.json` has `main: "boot.js"`, `name: "snapsolve"` and no `dependencies`/`devDependencies`.

## Spec refs
SPEC §8.1; DESIGN §4.1, C4; ARCHITECTURE module map `bootstrap/`.

## Notes
Electron resolves `require("electron")` as a built-in from any path, so `main.js` loaded through the `current` junction works. `boot.js` cannot import TypeScript from `src/`; the parity test is what keeps it in step with `paths.ts`.
