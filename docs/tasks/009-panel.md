# 009 · Panel window, preload API and UI

## Objective
SPEC §4.1–4.4 and §2.2: the side panel, its cards and the capture → store → runner → panel pipeline.

## Scope
In:  `src/main/panel.ts` (window per platform, `setContentProtection(true)` before first show, pure `computeBounds(state, display, panelWidth)`, 6-step 120 ms transitions, `showInactive`, IPC handlers, `snapsolve://` protocol via store, window.open deny, will-navigate prevent, `openExternal` http(s) guard); `src/main/app.ts` orchestrator (`onCapture(result)`, `onAppend`, `followUp`, `retry` → store + runner + panel); `src/preload/preload.ts` (exactly the 9 SPEC §4.4 functions); `src/renderer/index.html` (CSP meta), `renderer.ts`, `styles.css` (cards, Thinking…, follow-up box, Copy, Retry, status line, ×, Esc, tab). Test hook when `SNAPSOLVE_TEST=1`: `globalThis.snapsolveTest.captureFromFile(png)` feeds a fixture through the same path as a capture.
Out: hotkeys, tray, single instance (010); auth/usage text (011).

## Done when
- [ ] task tests pass; `npm run build` exits 0
- [ ] `npm start` with a test data dir opens the app without errors in the log

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- unit computeBounds: tab 8×72 at the right edge, vertically centered (work area 1280×800 → x 1272, y 364); open 420 × work-area height at right − 420; second-display offsets respected; panelWidth wider than the display is clamped.
- unit openExternal guard: http/https allowed; `javascript:`, `file:`, `ms-settings:`, `mailto:` and malformed URLs rejected.
- unit protocol resolver: valid UUID + n → file inside the thread dir; traversal, non-UUID, missing file → 404.
- e2e (fake claude): `captureFromFile` → panel visible and not focused; card shows "Thinking…" before the first delta, then a rendered answer with `.katex`; follow-up adds a second answer to the same thread.
- e2e: window is content-protected; CSP meta present; `window.open` returns null; preload exposes exactly the 9 names.
- e2e: × collapses to tab bounds; Esc after clicking into the panel collapses; with `autoHideSec` 0 the panel is still open 2 s after the answer ends.

## Spec refs
SPEC §2.2, §4.1, §4.2, §4.3, §4.4.

## Notes
SPEC Amendment 2 (2026-10-14) adds `openScreenRecordingSettings()` and `relaunch()` for the macOS card; 030 adds them and moves the 9-name check to 11. 009 ships the nine.
