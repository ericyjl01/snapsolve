# 083 · crop-corners equals icon for the menu bar and the title bar

## Objective
Eric wants the menu-bar icon to say what snapsolve does. Chosen (chat 2026-10-23): "crop corners around the equals sign": four screenshot crop corners (⌜ ⌝ ⌞ ⌟) framing a bold "=". It replaces the ring-and-dot tray icon, and the window's title-bar mark (today a check in a rounded square) becomes the same symbol so the app has one identity.

## Scope
In:
- `drawTrayIcon(size, rgb)` (src/main/tray.ts) draws the new symbol instead of the ring and dot: four L-shaped corners at the edges of the square (each arm about 30% of the side, stroke about size/8, at least 2 px) and two horizontal bars centred inside (each about 45% of the side wide, stroke as the corners, gap about size/8). Pixels stay fully opaque or fully transparent (macOS template image), the colour as given, the centre column between the corners empty except for the bars. Same 32 px @2x template image on macOS; Windows keeps its blue.
- The title-bar `.mark` SVG in src/renderer/index.html becomes the same symbol (stroked paths, `currentColor`, accent coloured as today).
- The comment at the top of tray.ts and SPEC wording that names the ring and dot: SPEC Amendment 17; DECISIONS row.
Out: the app (Finder/Dock) icon (backlog 033); an animated or state-dependent icon.

## Done when
- [ ] `npx vitest run test/unit/tray.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] the 16 and 32 px bitmaps have the four corners and two bars (unit), and the title bar's mark has the same shape (e2e)

## Tests
Command: `npx vitest run test/unit/tray.test.ts test/e2e/panel.e2e.test.ts`
- tray unit (replaces the ring test), for 16 and 32 px: BGRA of size², every alpha 0 or 255, colour stored B, G, R
- tray unit: each of the four corner pixels (0,0), (s-1,0), (0,s-1), (s-1,s-1) is opaque, and a pixel one arm-length along each edge from each corner is opaque while the middle of each edge is transparent (corners, not a full frame)
- tray unit: two horizontal bars: in the centre column, scanning top to bottom inside the frame, there are exactly two separate opaque runs, each wider (left to right) than tall, and the exact centre pixel between them is transparent
- tray unit: no ring left: a pixel at the old ring radius on the diagonal (inside the frame, off the bars) is transparent
- e2e: `#titlebar .mark` holds four corner paths and two bar paths (by `d`), stroked with `currentColor`, and is accent coloured

## Spec refs
SPEC §1.2 (tray); task 010.

## Notes
Eric 2026-10-23 (chat): asked for a maths-operator icon ("equal sign", "Riemann sum", "integral", "x to the power"); after the discussion: "crop corners around the equals sign, log it as a task".
