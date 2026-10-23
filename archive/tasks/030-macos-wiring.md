# 030 · macOS app wiring: permission card, Dock, login PATH

## Objective
SPEC §9.1 / §7.1 on a Mac: the app runs as a menu-bar app without a Dock icon, spawns `claude` with the login-shell PATH, and a missing Screen Recording grant shows a card with Grant / Open System Settings / Relaunch.

## Scope
In:  `src/main/main.ts` (darwin: `app.dock?.hide()` before the tray appears; `withLoginShellPath` from 028 applied once at startup and its warning logged; `systemPreferences` passed to the capturer from 029); the `screenRecordingDenied` card (009/011 card system): `prompted: true` → "Grant Screen Recording in the prompt, then click Relaunch" + Relaunch; `prompted: false` → Open System Settings (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`, opened by main, fixed URL) + Relaunch (`app.relaunch(); app.exit()`); tray and notifications show the macOS hotkey label (Ctrl+Option+Q). SPEC Amendment 2: `openScreenRecordingSettings()` and `relaunch()` in `src/preload/preload.ts`, their channels in `src/shared/ipc.ts` and their main handlers (fixed URL, macOS only; relaunch then exit); 009's e2e "exactly the 9 names" check becomes the 11 names. `test/unit/macos.test.ts` over DI'd functions (`darwinStartup(deps)`, card model for both permission states).
Out: installer (031); the checklist (032).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/macos.test.ts`
- darwin startup hides the Dock icon before creating the tray; win32 startup never touches `app.dock`.
- darwin startup passes the merged PATH env to the runner and logs the shell warning when the shell failed; win32 passes `process.env` unchanged.
- Card model for `screenRecordingDenied`: `prompted: true` → Relaunch only, grant text; `prompted: false` → Open System Settings + Relaunch.
- Open System Settings opens exactly the fixed `x-apple.systempreferences:` URL via main (the renderer passes no URL); Relaunch calls `relaunch` then `exit`.
- The open-settings handler ignores the call outside macOS and ignores any arguments sent on its channel; `openExternal` still refuses an `x-apple.systempreferences:` URL.
- Hotkey label: darwin → "Ctrl+Option+Q", win32 → "Ctrl+Alt+Q" (from the configured accelerator).

## Spec refs
SPEC §1.1, §4.4, §7.1, §9.1; DESIGN §3.2 step 5, §3.6, §7.

## Notes
Open question (blocked at planning): SPEC §4.4 says the preload exposes *exactly* nine functions, none of which can open a non-http(s) URL or relaunch; SPEC §7.1 requires the Open System Settings and Relaunch buttons. Proposed: SPEC Amendment adding `openScreenRecordingSettings()` and `relaunch()` (no arguments; main opens the fixed URL) to the preload.
Answer (2026-10-14): yes — SPEC Amendment 2, DECISIONS row; Scope and Tests updated.
