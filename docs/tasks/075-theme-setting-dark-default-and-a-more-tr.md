# 075 · theme setting (dark default) and a more translucent window

## Objective
Eric wants snapsolve dark while his Mac stays in Light mode, and the window a bit more see-through. Today the panel follows the system appearance only (061's `prefers-color-scheme` tokens), and its ground is ~72% opaque (light) / ~66% (dark).

## Scope
In:
- config.json `theme`: `"dark"` (default) | `"light"` | `"system"`; anything else falls back to `"dark"` with one warning, like every other key. Main sets Electron `nativeTheme.themeSource` from it before the window is created (`"system"` → `"system"`), so the renderer's `prefers-color-scheme` and the macOS vibrancy material both follow it. An existing config.json without `theme` gets the default (never rewritten, as today).
- the installer's default config.json gains `"theme": "dark"`; SKILL.md install section mentions it in one line.
- `--ground` alpha: light 0.72 → 0.56, dark 0.66 → 0.50 (Eric: "a bit more", about 55% solid); `--card`/`--row` unchanged so answer text stays readable.
- SPEC Amendment 12 (§6.1 config, §4.2 look); DECISIONS rows.
Out: a theme switch in the tray or the window; per-display themes; a translucency setting; Windows.

## Done when
- [ ] `npx vitest run test/unit/config.test.ts test/unit/panel.test.ts test/unit/installer-steps.test.ts test/unit/skill.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] with no `theme` in config.json, the running panel matches `(prefers-color-scheme: dark)` while macOS is Light (e2e)

## Tests
Command: `npx vitest run test/unit/config.test.ts test/unit/panel.test.ts test/unit/installer-steps.test.ts test/unit/skill.test.ts test/e2e/panel.e2e.test.ts`
- config: default `theme` is `"dark"`; `"light"`, `"system"`, `"dark"` accepted; `"blue"`, `1`, `null` → `"dark"` with one warning naming `theme` and its allowed values; a missing `theme` in an existing file → default without a warning and the file untouched
- panel/main wiring: `themeSource` is set from config before the window is created (`"system"` passes through as `"system"`); a test double records the order
- e2e: no `theme` → the renderer matches `(prefers-color-scheme: dark)`; `theme: "light"` → it does not; the body's computed background alpha is 0.56 (light) / 0.50 (dark), not the old 0.72 / 0.66
- installer-steps: the written default config.json has `"theme": "dark"`; an existing config.json is left untouched
- skill: the install section names the `theme` key and its three values

## Spec refs
SPEC §4.2, §6.1, Amendments 9 and 11; task 061.

## Notes
Eric 2026-10-22 (chat): theme "Setting, default dark"; translucency "A bit more" (~55% solid).
