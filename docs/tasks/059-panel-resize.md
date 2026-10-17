# 059 · panel: resize the open panel by its edges, size remembered

## Objective
Eric (2026-10-17): "I can't … resize it as I want. That should be a feature." The open panel is `panelWidth` (config, 240–2000) × full work-area height with `resizable: false`. Let the user resize the open panel by dragging its edges and keep that size for later captures. Builds on 058's saved-bounds store.

## Scope
In:
- SPEC §4.1 amendment (same DECISIONS row as 058 or a new one): open panel size is user-resizable; `panelWidth` becomes the default width before any resize.
- `resizable: true` while open with `minWidth` 240 / a sensible `minHeight` (e.g. 300); resizing disabled (or ignored) in the tab state so the 8 × 72 tab cannot be resized.
- Frameless resize on macOS works from the window edges; confirm it does with `type: "panel"`, and if not add renderer edge handles.
- `resized` (debounced) writes width and height into 058's saved rect for that display; open/hide/redock restore and clamp it.
- 058's "Reset panel position" also resets the size.
Out: making `panelWidth` in config.json follow the drag (config stays the user's file); Windows paths.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: drag the panel's left edge to make it ~600 px wide and its bottom edge to make it half height; capture again — same size; Esc then reopen — same size; tab cannot be resized

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- "resized open panel saves width and height" — proves a resize in the open state updates the saved rect for that display
- "resize below minimum is clamped" — proves width < 240 and height < minHeight are not saved or applied
- "saved size larger than the work area is clamped" — proves a size saved on a big display fits a smaller one
- "tab state is not resizable" — proves collapse sets resizable false (or ignores resized events) and the tab stays 8 × 72
- "transition steps go to the saved size" — proves the open animation ends exactly at the saved rect
- "no saved size uses panelWidth × work-area height" — proves the default is unchanged
- e2e "resized panel reopens at the new size" — proves setBounds-driven resize persists across collapse + open

## Spec refs
SPEC §4.1 (to amend), §5 config `panelWidth`; `src/main/panel.ts`.

## Notes
Depends on 058 (shared saved-bounds store and clamp).
