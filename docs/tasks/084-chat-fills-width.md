# 084 · chat column and composer widen with the window (no 560 px cap)

## Objective
Eric (0.2.5): "The text is a fixed box, but I can drag the window larger.. So when I drag the window larger, the text does not fill the entire window, but rather stays fixed to a limit. The text should appear wider if I drag the window wider. This wasn't a problem before." Cause: task 078 (0.2.4) added `max-width: 560px; margin-inline: auto` on `#threads`, `.empty` and `.composer > *` inside `@media (min-width: 600px)` (src/renderer/styles.css, the "comfortable line" rule), so from 600 px wide the chat stops growing and sits centred.

## Scope
In:
- Remove the 560 px cap: at every window width the chat column (`#threads`), the empty state and the composer pill fill the space beside the sidebar (or the whole window when the sidebar is closed or an overlay), keeping today's side padding (`#threads` 10 px, composer 10 px, `.empty` 16 px).
- Answer text, questions and screenshots reflow with the width (the bubbles keep their 85% / 70% caps of the column).
- SPEC Amendment 18 (replaces Amendment 15's centred ~560 px chat column); DECISIONS row.
Out: a user-set reading width; changing the sidebar's 232 px; the narrow (< 600 px) layout, which already fills.

## Done when
- [ ] `npx vitest run test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e: with the sidebar closed at 1100 px, the answer, the chat column and the composer pill each span the window minus their padding (wider than 1000 px); docked open at 1100 px they span the area right of the sidebar

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- e2e: 1100 px, sidebar closed: `#threads`, the finished `.answer` and `.composer-box` are each ≥ window width − 2 × their side padding − 2 px, and start within their padding of the window's left edge (not centred in a 560 px column)
- e2e: 1100 px, sidebar docked open: the same three span from the sidebar's right edge to the window's right edge, minus padding
- e2e: widening from 760 to 1100 px with the sidebar closed makes the answer wider by about the 340 px difference (it tracks the window, no plateau)
- e2e: 360 px (narrow) unchanged: the answer still spans the window minus padding
- 078's docked-sidebar case ("contentBox.x >= navBox.x + navBox.width") still passes unchanged

## Spec refs
SPEC Amendments 15, 18; task 078.

## Notes
Eric 2026-10-23 (chat), quoted in Objective. What changed: 078's Scope line "the chat column and composer are centred with a max width of ~560 px" (a ChatGPT-style reading column), shipped in 0.2.4.
