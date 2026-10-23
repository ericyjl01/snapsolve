# 001 · Repo layout and one-command build/run

## Objective
Electron app skeleton at the repo root that builds with one command and passes a headless smoke run.

## Scope
In:  package.json (name `snapsolve`, version 0.1.0, `electron` pinned exactly 44.7.2, `esbuild`, `typescript`, `@types/node`; scripts `build`, `start`, `smoke`), tsconfig.json, `scripts/build.mjs` (esbuild: `src/main/main.ts` → `dist/main.js` (node, electron external), `src/preload/preload.ts` → `dist/preload.js`, `src/renderer/renderer.ts` → `dist/renderer/renderer.js`, copies `src/renderer/index.html` + `styles.css`; then `tsc --noEmit`), minimal `src/main/main.ts` (`--smoke`: on `ready` print `snapsolve smoke ok <version>` and exit 0; no windows, no hotkeys), placeholder preload/renderer files, `.gitignore` additions (`node_modules/`, `dist/`, `coverage/`, `*.log`), `test/smoke/run-smoke.mjs`.
Out: any feature behavior; the vitest harness (002).

## Done when
- [ ] `node test/smoke/run-smoke.mjs` exits 0 and prints `snapsolve smoke ok 0.1.0`
- [ ] `npm run build` exits 0 and `dist/main.js`, `dist/preload.js`, `dist/renderer/index.html` exist
- [ ] `npm ls electron` shows exactly `electron@44.7.2`
- [ ] after the build and the smoke run, `git status --porcelain` lists nothing new (build artifacts are in `.gitignore`)

## Tests
Command: `node test/smoke/run-smoke.mjs`
- run-smoke — proves `npm run build` succeeds and `electron dist/main.js --smoke` reaches `ready`, prints the expected line and exits 0 within 60 s. Fails with a clear message on: build failure, missing `dist/main.js`, non-zero exit, wrong/missing output line, timeout (process killed). Runs with `SNAPSOLVE_DATA_DIR` set to a fresh temp dir so the real data dir is never touched.

## Spec refs
SPEC §1.2, M1; ARCHITECTURE `## Build and test`, `## Module map`.

## Notes
