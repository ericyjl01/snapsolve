# 077 · tray Appearance menu: switch dark / light / match macOS live

## Objective
Eric wants to switch snapsolve between dark and light from the menu instead of editing config.json and restarting (Amendment 12 left a tray switch out). The menu-bar (tray) menu gains an Appearance choice that applies at once and is remembered.

## Scope
In:
- Tray menu: an "Appearance" submenu with three radio items, "Dark", "Light", "Match macOS" (config values `dark`, `light`, `system`); the current `config.theme` is checked. Placed after "Reset position".
- Choosing one: sets `nativeTheme.themeSource` immediately (the open window restyles live through `prefers-color-scheme`, no restart, no reload), updates the in-memory config, and saves `theme` into config.json keeping every other key and the file's other values as they are (atomic write, like the store's writes). A missing or unreadable config.json is written with just the defaults plus the new theme.
- Re-selecting the current item does nothing (no write).
- SPEC Amendment 14 (supersedes Amendment 12's "a change takes effect on restart" and its Out "a theme switch in the tray"); DECISIONS row.
Out: a switch inside the window; per-display themes; a translucency setting; Windows.

## Done when
- [ ] `npx vitest run test/unit/tray.test.ts test/unit/config.test.ts test/unit/app.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e: with config `{}` (dark), invoking the tray's Light item turns `prefers-color-scheme: dark` false and the body ground to `rgba(246, 246, 248, 0.88)` without a reload, and config.json then has `"theme": "light"`

## Tests
Command: `npx vitest run test/unit/tray.test.ts test/unit/config.test.ts test/unit/app.test.ts` (plus the e2e case in `test/e2e/panel.e2e.test.ts`)
- tray unit: the menu has an "Appearance" submenu after "Reset position" with radio items Dark, Light, Match macOS; exactly the one matching the given theme is checked, for each of the three themes
- tray unit: clicking an item calls the handler with `dark` / `light` / `system`; clicking the checked one does not call it
- tray unit: after a change the menu is rebuilt with the new item checked
- config unit: `saveTheme(dataDir, "light")` on a config.json with other keys (and unknown keys) rewrites only `theme`, all other keys and values unchanged, written atomically (no partial file on a failed write)
- config unit: `saveTheme` on a missing config.json writes the defaults with the new theme; on an unparsable one it leaves the bad file untouched and returns an error (logged, no crash)
- app unit: the theme handler sets `nativeTheme.themeSource` to the choice before the save resolves, and updates the config the next window reads
- e2e: as in Done when (driven through a `snapsolveTest` hook that calls the same handler the tray item calls)

## Spec refs
SPEC §6.1, Amendments 12 and 13; tasks 010 (tray), 075 (theme).

## Notes
Eric 2026-10-22 (chat): "should be button in menu to change from dark/light mode." Three choices rather than a dark/light toggle so the existing `system` value stays reachable.
