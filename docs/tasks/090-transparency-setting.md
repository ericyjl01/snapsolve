# 090 · see-through window that works, with a Transparency setting in the menu-bar menu

## Objective
Eric (0.2.7): "SnapSolve is not a translucent background. So I want you to make that change. there should be a bar on the menu app that lets me change how transparent the window is." 076 (Amendment 13) meant the window to be ~88% solid and see-through like a terminal, but on Eric's Mac it looks solid. Likely cause: src/main/panel.ts creates the macOS window with `backgroundColor: "#00000000"` but not `transparent: true`, so the renderer's `rgba(…, 0.88)` ground (styles.css `--ground`) is drawn over an opaque window. Make the see-through real and let Eric choose how see-through from the tray.

## Scope
In:
- macOS window created with `transparent: true` (plus whatever Electron needs alongside it for a frameless, resizable, shadowed panel); confirm on Eric's Mac that the desktop shows through.
- Tray › **Transparency ›** radio items: `Solid` (100% ground), `10%`, `20%` (today's intended 88% ≈ this), `30%`, `40%`, `50%`, checked = current; a pick applies live (no restart) and is saved to config.json as `transparency` (0–50, default 20), like Appearance (077: `saveTheme`-style single-key save, other keys untouched).
- Only the window's ground (background) becomes see-through; text, code blocks, bubbles, sidebar and the text bar stay readable (their own backgrounds keep a minimum opacity).
- Electron menus cannot hold a draggable slider, so the "bar" is the submenu of steps (Eric to confirm; a real slider would need a small separate window — out of scope here).
- config.json validation for `transparency` (integer 0–50; invalid → default with the usual config warning); SPEC Amendment 23; DECISIONS row; checklist row.
Out: OS blur (vibrancy — Amendment 13 chose no blur); per-display transparency; a slider window.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/unit/tray.test.ts test/unit/config.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: on darwin the BrowserWindow options include `transparent: true`
- [ ] unit: the tray has Transparency › Solid, 10%, 20%, 30%, 40%, 50% with the configured one checked; a pick calls the handler once and rebuilds the menu
- [ ] e2e: setting transparency 40 makes the computed ground alpha 0.60 (and Solid → 1); text colour alpha stays 1
- [ ] hand check on Eric's Mac (checklist row): a window behind snapsolve shows through at 20% and more at 50%

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/unit/tray.test.ts test/unit/config.test.ts test/e2e/panel.e2e.test.ts`
- unit (panel): darwin window options have `transparent: true` and a fully transparent backgroundColor; other platforms unchanged
- unit (tray): Transparency submenu after Appearance; six radio items in order; checked follows config; picking the checked one does nothing; picking another calls `onTransparency(n)` and the menu is rebuilt with it checked
- unit (config): `transparency` default 20; 0 and 50 accepted; -1, 51, 12.5, "20" rejected → default + warning; saving it keeps every other key
- e2e: config `transparency: 40` → body ground alpha 0.60; a live change through the test hook to 0 → alpha 1.0, no reload; the answer text colour is opaque
- edge: light and dark themes both follow the setting

## Spec refs
SPEC §4.1, Amendments 13, 14, 23; tasks 076, 077.

## Notes
Eric 2026-10-23 (chat), quoted in Objective. Ask Eric whether the menu steps are fine instead of a slider.
