# 087 · crop-corners icon about 15% smaller (menu bar and title bar)

## Objective
Eric (0.2.7), about the icon: "Icon looks right for 033." then "033. Let's make the icon like 15% smaller." Read as: the crop-corners "=" symbol (083) is right but a little big; draw it about 15% smaller in the menu bar and in the title bar. (033, the Finder app icon, stays in the backlog as is.)

## Scope
In:
- `drawTrayIcon(size, rgb)`: the same symbol drawn inside a centred square about 85% of `size` (transparent margin around it), same proportions (arms ~30%, stroke ~1/8 of the symbol, at least 2 px; bars ~45% wide, gap ~stroke), still fully opaque or transparent pixels.
- The title-bar `.mark` SVG drawn about 15% smaller (same paths scaled about the centre, or the same viewBox with a smaller drawn size).
- 083's tray tests updated to the inset symbol (corners at the symbol's edges, not the bitmap's); SPEC Amendment 21; DECISIONS row.
Out: the Finder/Dock app icon (033); any other change to the symbol.

## Done when
- [ ] `npx vitest run test/unit/tray.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: at 16 and 32 px the opaque pixels' bounding box is 80–90% of the side and centred (±1 px); the four corners, two bars and empty centre hold inside it
- [ ] e2e: the title-bar mark's drawn size is 80–90% of 083's

## Tests
Command: `npx vitest run test/unit/tray.test.ts test/e2e/panel.e2e.test.ts`
- unit: 16 and 32 px: bounding box of opaque pixels 80–90% of size, centred within 1 px; the outer ring of pixels at the bitmap edge is transparent
- unit: 083's corner / bar / no-ring checks, measured against that bounding box
- unit: all alpha 0 or 255, colour B, G, R (unchanged)
- e2e: `#titlebar .mark` bounding box (getBoundingClientRect of its paths) is 80–90% of 083's 14 × 14 drawn mark

## Spec refs
SPEC §1.2, Amendments 17, 21; task 083.

## Notes
Eric 2026-10-23 (chat), quoted in Objective. If Eric meant the Finder app icon (033), re-scope.
