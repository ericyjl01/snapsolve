# 010 · Hotkeys, tray and app lifecycle wiring

## Objective
SPEC §1.1–1.2: hotkeys, tray, single instance and system events wired to the pipeline from 009.

## Scope
In:  `src/main/hotkeys.ts` `createHotkeys({ globalShortcut, config, onCapture, onAppend, notify, now })` (register, 400 ms capture debounce, failure notification, pause/resume, `reRegisterIfLost`); `src/main/tray.ts` `createTray({ Tray, Menu, … })` (Open panel · Pause/Resume hotkeys · Open history folder · Clear history · Quit; tooltip setter); `src/main/main.ts` (single-instance lock, `second-instance` with `--quit` → quit else open panel, `powerMonitor` resume → `reRegisterIfLost`, screen events → re-dock, Clear history native confirm → `store.clearHistory`, append targets the most recent capture's thread, Open history folder → `shell.openPath`). Test hooks: `snapsolveTest.hotkeyStatus()`, `snapsolveTest.appendFromFile(png)`.
Out: auth/usage text (011).

## Done when
- [ ] task tests pass; `npm run build` exits 0
- [ ] `npm start`: tray icon visible; Ctrl+Alt+Q produces a card (manual, fake or real claude)

## Tests
Command: `npx vitest run test/unit/hotkeys.test.ts test/unit/tray.test.ts test/e2e/lifecycle.e2e.test.ts`
- hotkeys: registers both accelerators from config; `register` false → `notify` names the key and `hotkeys.capture`; presses 399 ms apart → one capture, 401 ms → two (fake clock); pause unregisters both; resume re-registers; `reRegisterIfLost` re-registers only the missing one.
- tray: exactly five items in order; Pause label flips to Resume and back; tooltip shows the given usage string.
- e2e: second launch with `--quit` → first instance exits 0 within 10 s; second launch without args → first instance opens the panel and the second exits; both hotkeys registered at startup; `appendFromFile` adds a screenshot to the most recent capture's thread.

## Spec refs
SPEC §1.1, §1.2, §3.5 (append target).

## Notes
