# 091 · default window: centred on the screen, about 9 in × 6 in real size

## Objective
Eric (0.2.7): "SnapSolve's default window position should be centered on the screen around real life size of an 9in wide and 6in tall." Today `defaultBounds` (src/main/panel.ts) puts a 360 × 460 window 24 px from the top-right of the work area (Amendment 6/7).

## Scope
In:
- `defaultBounds(display)` returns a window about 9 in × 6 in on that display, centred in its work area, clamped into it (a small screen gets the largest fit, never below 280 × 300).
- Real size from the display's physical size: on macOS `CGDisplayScreenSize` (mm) for the display, via the existing Swift helper build path (063's `native/`) or an equivalent call; points per inch = display width in points ÷ width in inches. If the physical size is unknown (0 mm, helper missing, mirrored/virtual display), assume 110 pt per inch (a 34" 3440-wide ultrawide like Eric's is ~110; a 14" MacBook at default scaling is ~127) and log it.
- Where the default applies: the first open on a display with no saved bounds, and tray › Reset window position. Saved position and size (058/059) still win otherwise; Eric's saved bounds stay until he uses Reset.
- SPEC Amendment 22 (replaces the 360 × 460 top-right default of Amendments 6 and 7); DECISIONS row (incl. the 110 pt/in fallback); checklist row 16 updated.
Out: remembering size per physical inch across displays; changing the minimum size.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: a 3440 × 1440 work area with a 800 × 335 mm display gives about 983 × 655 (±2%) centred; a 1512 × 945 area at 302 × 189 mm gives about 1145 × 763 (±2%) centred
- [ ] unit: unknown physical size → 990 × 660 (110 pt/in), centred, clamped
- [ ] e2e: a fresh data dir opens the window centred in the work area (±1 px) at the size defaultBounds gives for that display; Reset window position returns to it after a drag

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- unit: defaultBounds with physical mm known: size = 9 in × 6 in in points (±2%), x/y centred in the work area, whole pixels
- unit: work area smaller than 9 × 6 in → shrunk to fit with the same centre, never below 280 × 300
- unit: physical size 0 / missing → 110 pt/in fallback, and the fallback is reported (log)
- unit: saved bounds still restored unchanged (058/059 tests pass); Reset uses the new default
- e2e: fresh launch → centred at the computed size; drag, Reset → back to it
- edge: work area offset (menu bar, Dock on the left) → centred within the work area, not the full screen

## Spec refs
SPEC §4.1, Amendments 6, 7, 22; tasks 058, 059.

## Notes
Eric 2026-10-23 (chat), quoted in Objective. At 9 in wide the window is past 600 px, so the Chats sidebar starts docked open.
