# 059 · window: resize from any edge or corner, size remembered

## Objective
Eric (2026-10-17, mockup A2): the floating window resizes from any edge or corner, and keeps its size for later captures. Builds on 058's saved-bounds store.

## Scope
In:
- SPEC amendment (with 058's or its own DECISIONS row): the window is user-resizable; `panelWidth` in config.json no longer sets the size (default 360 × 460; keep the key accepted and ignored with a one-time warning, or remove it from the defaults — decide in the DECISIONS row).
- `resizable: true`, `minWidth` 280, `minHeight` 300; macOS frameless edge resizing works with `type: "panel"` (confirm; if not, renderer edge handles with pointer capture as in the mockup).
- A small resize grip drawn in the bottom-right corner (visual only).
- `resized` (debounced) writes width and height into the saved rect for that display; open/hide/redock restore and clamp it. 058's reset also resets the size.
Out: making config.json follow the drag (config stays the user's file); Windows paths.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: drag the left edge and the bottom-right corner to about 500 × 600; capture again: same size; it cannot go below 280 × 300

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- "resize saves width and height" — proves a resize updates the saved rect for that display
- "below minimum is clamped" — proves width < 280 or height < 300 are neither applied nor saved
- "saved size larger than the work area is clamped" — proves a size saved on a big display fits a smaller one
- "resize during an animation is not saved" — proves only user resizes are stored
- "no saved size uses 360 × 460" — proves the default
- e2e "resized window reopens at the new size" — proves the size persists across hide + show

## Spec refs
SPEC §4.1 (to amend), §5 `panelWidth`; `src/main/panel.ts`; `src/main/config.ts`.

## Notes
Depends on 058.
