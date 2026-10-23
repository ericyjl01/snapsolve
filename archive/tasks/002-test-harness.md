# 002 · Test harness in one command

## Objective
`npm test` runs unit, integration and Electron e2e tests in one command; keel's gate uses it.

## Scope
In:  devDeps `vitest`, `jsdom`, `playwright-core`; `vitest.config.ts` (includes `test/unit`, `test/integration`, `test/e2e`; excludes `test/live`; e2e files run sequentially); `vitest.live.config.ts` (`test/live` only, `passWithNoTests`); scripts `test` (with `pretest` = `npm run build`) and `test:live`; `test/e2e/helpers.ts` (`launchApp(opts)`: `_electron.launch` on `dist/main.js` with `SNAPSOLVE_TEST=1`, temp `SNAPSOLVE_DATA_DIR`, returns app + cleanup); `test/unit/harness.test.ts`; `test/e2e/launch.e2e.test.ts`; set `.claude/memory/keel.json` `test_command` to `npm test`.
Out: feature modules.

## Done when
- [ ] `npm test` exits 0 and reports at least 2 passing tests
- [ ] `.claude/memory/keel.json` `test_command` is `npm test` and `python3 .claude/memory/check.py caps` still exits 0
- [ ] `npm run test:live` exits 0 (no live tests yet)
- [ ] after running the full suite, `git status --porcelain` lists nothing new (`node_modules/`, `dist/`, coverage output are ignored)

## Tests
Command: `npx vitest run test/unit/harness.test.ts test/e2e/launch.e2e.test.ts`
- harness.test.ts — proves vitest runs TypeScript with Node built-ins and resolves `test/fixtures/` from the repo root.
- launch.e2e.test.ts — proves the built app launches via playwright-core within 30 s, `app.getName()` is `snapsolve`, the process receives `SNAPSOLVE_DATA_DIR`, and it closes cleanly (no orphan process). Error case: a missing `dist/main.js` fails with a message telling you to run `npm run build`.

## Spec refs
ARCHITECTURE `## Build and test`, `## Conventions` (test layout).

## Notes
keel.json stays uncommitted on keel/002 and rides the `002: close` commit.
