# 060 · window: show/hide hotkey (Ctrl+Option+Z); hidden leaves nothing on screen

## Objective
Eric (2026-10-17, screenshot of the 8 × 72 accent strip on the right edge): "There should be a hotkey to open it and close it, and when I close it, there should be nothing visible at all. Not even this little tab." Today the panel collapses to that tab (SPEC §4.1) and only Esc (focused), a capture or tray "Open panel" change state (Amendment 3).

## Scope
In:
- DECISIONS row (verbatim) + SPEC amendment to §4.1/§4.3: two states, shown and hidden; hidden = `win.hide()`, no tab, nothing on screen.
- New `hotkeys.toggle`, default `Control+Alt+Z`, registered with the others (taken-key notification, pause/resume, re-register like capture/append); config validation (accelerator, must differ from capture and append; on a clash fall back to defaults with a warning, as today).
- Toggle: hidden → show at the saved bounds (058) with `showInactive` (focus stays in the user's app); shown → hide. Esc (focused) and the window's × button (061) hide too. A capture still shows it.
- Tray "Open panel" becomes "Show/Hide snapsolve (⌃⌥Z)" and toggles.
- Remove the tab: TAB_WIDTH/TAB_HEIGHT bounds, the tab border styling, and its transitions.
- `/snapsolve` SKILL.md and README mention the new hotkey.
Out: voice (063); the restyle (061).

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/unit/hotkeys.test.ts test/unit/config.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: Ctrl+Option+Z hides the window and nothing at all stays on screen; pressing it again shows it where it was, without taking focus from the app in front

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/unit/hotkeys.test.ts test/unit/config.test.ts test/e2e/panel.e2e.test.ts`
- "hidden state hides the window" — proves collapse/hide calls `win.hide()` and no 8 × 72 bounds are ever set
- "toggle shows at saved bounds with showInactive" — proves no focus steal on show
- "capture shows a hidden window" — proves the capture flow still opens it
- "hotkeys.toggle default and validation" — proves `Control+Alt+Z` default, invalid value → default + warning, clash with capture/append → defaults + warning
- "toggle hotkey registered, paused and re-registered" — proves it joins the existing hotkey lifecycle; taken key notifies naming `hotkeys.toggle`
- "tray item toggles and shows the hotkey" — proves the renamed tray entry
- e2e "toggle hides with nothing visible, then restores" — proves `isVisible()` false after toggle and bounds unchanged after showing again

## Spec refs
SPEC §4.1, §4.3, Amendment 3 (to amend); §5 config; `src/main/hotkeys.ts`, `src/main/panel.ts`, `src/main/tray.ts`, `src/main/config.ts`.

## Notes
Ctrl+Option+Z per Eric (DECISIONS 2026-10-17 hotkeys); same key shows and hides. Depends on 058 (saved bounds).
