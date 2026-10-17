# 058 · panel: drag to move the open panel, position remembered

## Objective
Eric (2026-10-17, first real use of 0.1.0 on his Mac): "I can't move the window around … that should be a feature." The open panel is pinned to the right edge (SPEC §4.1; `src/main/panel.ts` creates it with `movable: false`, and `open()`, `hide()` and `redock()` all snap it back to `computeBounds("open", …)`). Let the user drag the open panel anywhere and keep it there for later captures.

## Scope
In:
- DECISIONS row + SPEC amendment to §4.1: the open panel docks right by default; once the user drags it, it opens at the saved position.
- A drag strip at the top of the panel (`-webkit-app-region: drag` in `src/renderer/styles.css`/`index.html`; buttons and the follow-up box stay `no-drag`); `movable: true` for the window.
- Saved open-panel bounds per display (keyed by display id; stored in a small state file in the data dir, not config.json), written on `moved` (debounced) only while `state === "open"` and not mid-animation.
- `computeBounds("open", …)` (or a wrapper) uses the saved rect for that display when present, clamped fully into the work area; `open()`, `hide()` and `redock()` use it, so a capture or a display change no longer snaps the panel back to the edge.
- Tray item "Reset panel position" clears the saved bounds and re-docks right.
Out: resizing (059); the 8 × 72 tab stays on the right edge; Windows paths (Amendment 4).

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: drag the open panel to the left half, press Ctrl+Option+Q twice — it reopens where it was left; Esc collapses to the right-edge tab and reopening returns to the saved spot; "Reset panel position" puts it back on the right edge

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- "open uses saved bounds for the display" — proves open() moves to the saved rect, not the right-edge dock, when one exists for that display id
- "no saved bounds docks right" — proves today's §4.1 behavior is unchanged without a saved rect
- "saved bounds are clamped into the work area" — proves a rect partly or fully off-screen (display shrank/resolution change) is moved fully inside; a rect larger than the work area is clamped to it
- "saved bounds are per display" — proves a rect saved on display A is not used on display B
- "moved while animating or in tab state is not saved" — proves the 6-step transition and the tab never overwrite the saved rect
- "hide/show around a capture keeps the saved position" — proves hide() no longer resets to the right-edge dock
- "redock keeps a saved position" — proves a display-metrics change clamps instead of snapping to the edge
- "corrupt or missing state file" — proves startup falls back to the right-edge dock and logs a warning, no crash
- "reset clears saved bounds" — proves the tray action docks right and deletes the entry
- e2e "drag strip moves the window" — proves the window is movable and a moved panel reopens at the new x/y after collapse + open

## Spec refs
SPEC §4.1 (to amend), §4.3; DESIGN panel section; `src/main/panel.ts` computeBounds/open/hide/redock.

## Notes
Open questions for Eric (proposed defaults in brackets): should the tab follow the panel to the side it was dragged to [no, tab stays on right edge]; should the panel open on the cursor's display or the display it was last dragged to [cursor's display, using that display's saved rect].
