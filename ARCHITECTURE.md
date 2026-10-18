# Architecture

The app lives at the repo root. The distributable plugin (M2) is assembled from it by `scripts/release.mjs`.

## Module map
- `src/main/`: Electron main process. One module per job:
  - `main.ts`: entry; single-instance lock, `--quit`, `--smoke`, wiring, powerMonitor/screen listeners
  - `paths.ts`: data dir per OS, subdirectories, ensure-exists, `window.json` (floating-window position)
  - `config.ts`: config.json load / defaults / validation
  - `log.ts`: JSON-lines logger to `<data>/logs/snapsolve.log`
  - `store.ts`: threads on disk (thread.json, PNGs, owned transcripts), atomic writes, clear history
  - `stream.ts`: stream-json line splitter and event classifier (pure)
  - `runner.ts`: builds args/env/stdin, spawns `claude`, per-thread FIFO, global cap, timeouts, transcript adoption, resume fallback
  - `auth.ts`: `claude auth status`, usage/rate-limit formatting
  - `encode.ts`: resize / PNG→JPEG fallback for the image sent to the model (pure, over an image interface)
  - `capture.ts`: display + source selection, capture mutex, platform panel handling
  - `panel.ts`: the panel BrowserWindow, tab and floating-window bounds (saved per display in `<data>/window.json`: `loadWindowBounds` / `saveWindowBounds`, task 058), content protection, IPC handlers, `snapsolve://` protocol (`app/<file>` = the renderer from `dist/renderer`, `thread/<uuid>/<n>.png` = thumbnails), auto-hide timer
  - `app.ts`: the capture → store → runner → panel pipeline (`onCapture`, `onAppend`), the renderer's request handlers, runner events → panel, `resolveClaudeCommand`
  - `hotkeys.ts`: globalShortcut registration, debounce, pause/resume
  - `tray.ts`: tray menu and tooltip
  - `macos.ts`: darwin startup (Dock hidden before the tray, login-shell PATH once), the Screen Recording card's two actions (fixed settings URL, relaunch), hotkey labels per platform
- `src/preload/preload.ts`: contextBridge exposing exactly the eleven functions of SPEC §4.4 as amended by Amendments 2 and 9 (`copy` → `hide`)
- `src/renderer/`: `index.html`, `renderer.ts` (UI), `render.ts` (markdown → sanitized HTML), `styles.css`
- `src/shared/`: `types.ts` (Thread, Turn, Config, events), `ipc.ts` (channel names), `errors.ts` (error kinds + user messages)
- `prompts/system.md`: the system prompt
- `assets/`: icons (tray, app)
- `scripts/`: `build.mjs` (esbuild), `renderer-assets.mjs` (copies KaTeX CSS + fonts and the highlight.js theme into `dist/renderer/`), `smoke.mjs`, `make-problem-fixtures.ps1` (draws the live-test problem PNGs; Windows, run by hand); `release.mjs` (M2: assembles the plugin into a claude-skills marketplace folder, see `plugin/`)
- `test/`: `unit/`, `integration/` (fake claude), `e2e/` (Electron via playwright-core), `live/` (real claude), `fixtures/`
- `plugin/` (M2): `.claude-plugin/plugin.json` (no `version`, in the repo or the release: claude-skills convention, DECISIONS 027), `skills/snapsolve/SKILL.md`, `skills/snapsolve/scripts/` (installer, plain Node ESM, built-ins only: `steps.mjs` = the install steps the commands compose, each taking its dependencies; its data-dir rules and config defaults mirror `paths.ts` / `config.ts`, kept in step by `test/unit/installer-steps.test.ts`; `commands.mjs` = the five commands over injected steps, returning `ok:`/`warn:`/`fail:` lines; `snapsolve.mjs` = the CLI the skill runs; `realSteps.mjs` = the real steps it wires, with the test hooks inert unless `SNAPSOLVE_TEST=1`; install state in `<data>/app/install.json`). Released as `<marketplace>/plugins/snapsolve/` = `plugin/` + `app/` (`main.js`, `preload.js`, `renderer/`, `prompts/`, `assets/`, `bootstrap/`, `package.json` with `main: "main.js"`, the root `package-lock.json`)
- `bootstrap/` (M2): `boot.js` + `package.json` for the packaged launcher
- `dist/`: build output (gitignored)

## Canonical locations
- config: `src/main/config.ts` (file: `<data>/config.json`)
- data paths: `src/main/paths.ts`
- errors: `src/shared/errors.ts`
- IPC contract: `src/shared/ipc.ts`; shared types: `src/shared/types.ts`
- db access: none; persistence is `src/main/store.ts`
- logging: `src/main/log.ts`
- tests: `test/<kind>/<module>.<kind>.test.ts` (unit: `test/unit/<module>.test.ts`)
- fixtures: `test/fixtures/` (stream recordings, problem PNGs, `fake-claude.mjs`)
- scripts: `scripts/`

## Approved libraries
- app shell: `electron` 44.7.2, pinned exactly
- bundling: `esbuild` (main, preload, renderer → `dist/`)
- type-checking: `typescript` (`tsc --noEmit` only; esbuild transpiles)
- tests: `vitest`; `jsdom` (renderer tests); `playwright-core` (`_electron` e2e)
- markdown: `markdown-it`; math: `katex` + `@vscode/markdown-it-katex`; code: `highlight.js`; sanitizing: `dompurify`
- packaging (M2): `@electron/packager`
- types: `@types/node`, `@types/markdown-it`
- speech (063, macOS only): Apple `Speech` + `AVFoundation` frameworks, used only from a small Swift helper binary compiled with `swiftc` (DECISIONS 2026-10-17 speech-to-text); no npm package
- everything else: Node/Electron built-ins (`crypto.randomUUID`, `fs/promises`, `child_process`, `nativeImage`, `desktopCapturer`, `globalShortcut`, `Tray`, `protocol`)

## Conventions
- naming: files lowerCamel single-concept (`runner.ts`); types PascalCase; functions camelCase; IPC channels `area:verb` (`answer:delta`)
- dependency injection: every main module that touches Electron, the OS or a child process exports a factory taking its dependencies (`createRunner({ spawn, store, config, now })`) so unit tests run in plain Node without Electron
- error handling: throw or return `SnapsolveError` (`src/shared/errors.ts`) with a `kind`; the UI shows `userMessage(kind)`; nothing is swallowed silently — log it
- logging: `log.ts` JSON lines (`ts`, `level`, `event`, fields); never image bytes, base64, answer text or prompts
- async: `fs/promises`; atomic JSON writes via `store.writeJsonAtomic` (temp + rename)
- platform branches: `process.platform` checked only in `paths.ts`, `capture.ts`, `panel.ts`, `main.ts`, and passed in as a parameter elsewhere (tests cover both branches)
- decisions: rows of closed tasks 001–029 live in `archive/DECISIONS.archive.md` (moved by /keel tidy, 2026-10-17); grep it as well as DECISIONS.md before a choice
- test layout: one test file per module; e2e tests launch `dist/main.js` with `SNAPSOLVE_TEST=1`, a temp data dir (`SNAPSOLVE_DATA_DIR`) and the fake claude

## Exemplars
- module: `src/main/config.ts` (to be created by task 003)
- test: `test/unit/config.test.ts` (to be created by task 003)
- script: `scripts/build.mjs` (to be created by task 001)
- e2e test: `test/e2e/launch.e2e.test.ts` (to be created by task 002)
- migration: none (no database)

## Build and test
- build: `npm run build` (esbuild bundles + `tsc --noEmit`)
- run: `npm start` (build, then `electron dist/main.js`)
- test: `npm test` (unit + integration + e2e; fake claude only, no network)
- live: `npm run test:live` (real `claude`; consumes plan usage; never part of `npm test`)

## Do NOT
- Do not call the Anthropic API directly or require an API key; every model call goes through `claude -p` (SPEC §3.1).
- Do not change the §3.1 flag set; never use `--bare`, `--setting-sources` or `--system-prompt-file`.
- Do not enable `nodeIntegration`, disable `contextIsolation`/`sandbox`, load remote content, use `file://` in the renderer, or render model output without `render.ts`.
- Do not write screenshots, transcripts, history or logs outside the data dir (never Documents, Desktop, Pictures or OneDrive).
- Do not log image bytes, base64, prompts or answer text.
- Do not add concealment features beyond D18 (panel content protection): no process disguise, no hiding from Task Manager or app switchers, nothing aimed at proctoring or monitoring software.
- Do not use real `claude` in `npm test`; live tests only in `test/live/`.
- Do not commit `node_modules/`, `dist/`, packaged apps, or files from a real data dir.
- Do not add a runtime dependency outside `## Approved libraries`.
