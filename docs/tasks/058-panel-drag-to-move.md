# 058 · window: free-floating note-size window, drag to move, position remembered

## Objective
Eric (2026-10-17) chose mockup A2 (canvas https://claude.ai/artifact/YDwUWu2mMWHJui9b5unfPH, artboard "A2 · Floating note window"): snapsolve becomes a small floating window, about the size of a big sticky note, that he drags anywhere like an app, in place of the panel docked to the right edge at full height (SPEC §4.1; `src/main/panel.ts` today: `movable: false`, and `open()`, `hide()`, `redock()` snap back to `computeBounds("open", …)`).

## Scope
In:
- DECISIONS row (Eric's words, `(user, chat)`) + SPEC amendment replacing §4.1's open state: a floating window, default 360 × 460 logical px, first shown near the top-right of the cursor's display (24 px in from the right and top of the work area), then wherever the user leaves it.
- `movable: true`; a 36 px title bar in the renderer (`-webkit-app-region: drag`; its buttons `no-drag`).
- Saved bounds per display (keyed by display id) in a small state file in the data dir (not config.json), written on `moved` (debounced), never mid-animation.
- `open()`, `hide()`/`show()` around a capture, and `redock()` use the saved rect, clamped fully into the work area; no snapping to the edge.
- Tray item "Reset window position" clears the saved bounds.
Out: resizing (059); the hidden state and the tab (060); the new look (061); Windows paths (Amendment 4).

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: the window opens at 360 × 460 near the top-right; drag it to the middle, press Ctrl+Option+Q twice: it stays where it was left; "Reset window position" puts it back

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- "first open is 360 × 460 at the top-right of the cursor's display" — proves the new default bounds (24 px inset)
- "open uses saved bounds for the display" — proves a saved rect wins over the default
- "saved bounds are clamped into the work area" — proves a rect partly or fully off-screen (resolution change, display removed) is moved fully inside
- "saved bounds are per display" — proves a rect saved on display A is not used on display B
- "moved during an animation is not saved" — proves transition steps never overwrite the saved rect
- "hide/show around a capture keeps the position" — proves hide() no longer resets bounds
- "redock clamps instead of snapping" — proves a display-metrics change keeps the user's position when it still fits
- "corrupt or missing state file" — proves the default is used, a warning is logged, no crash
- "reset clears saved bounds" — proves the tray action restores the default and deletes the entry
- e2e "title bar drag moves the window" — proves the window is movable and reopens at the new x/y

## Spec refs
SPEC §4.1 (to amend), §4.3, Amendment 3; `src/main/panel.ts` computeBounds/open/hide/redock; `src/main/tray.ts`.

## Notes
Open question (proposed default in brackets): open on the cursor's display or the display it was last on [cursor's display, at that display's saved rect].
