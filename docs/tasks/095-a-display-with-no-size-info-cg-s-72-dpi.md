# 095 · a display with no size info (CG's 72 dpi guess) gets the 110 pt/in default

## Objective
Found in 091's review: Apple documents that `CGDisplayScreenSize` returns a size estimated at 72 dpi when the display gives macOS no EDID size (some virtual displays, adapters, projectors), instead of 0. 091 treats only 0 mm as unknown, so such a display would be read as ~72 pt/in and get a window of about 648 × 432 instead of the 110 pt/in fallback (990 × 660). Not seen on Eric's Mac (his LG reports 801.6 × 329.5 mm).

## Scope
In:
- `pointsPerInch` (or `readDisplaySizes`) treats a size that comes out at 72 pt/in (± a small tolerance, in the display's pixels, not points, if that is what CG's guess is based on) as unknown, so the 110 pt/in fallback applies and is logged.
- Unit tests for the guess and for real displays near it.
Out: any other physical-size source; per-display overrides in config.json.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/unit/macos.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: a 1920 × 1080 display reported at 677.3 × 381 mm (exactly 72 dpi) → unknown → 990 × 660; a real 24" 1920-wide display (531 × 299 mm, ~92 pt/in) is kept

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/unit/macos.test.ts`
- exact 72 dpi from the pixel size → unknown, fallback logged once
- 71.5 and 72.5 dpi (rounding in CG's guess) → unknown; 80 and 92 dpi → known
- a Retina display whose points ≠ pixels: the check uses what CG's estimate is based on (verify on a Mac before choosing)

## Spec refs
SPEC §4.1, Amendment 22; task 091.

## Notes
Backlog (reviewer of 091, 2026-10-23). Check CG's exact behaviour (pixels or points) before writing the threshold.
