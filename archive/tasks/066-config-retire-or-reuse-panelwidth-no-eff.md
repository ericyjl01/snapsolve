# 066 · config: retire or reuse panelWidth (no effect since 058)

## Objective
Since 058 (SPEC Amendment 6) the floating window is 360 × 460 and `panelWidth` (default 420, 240–2000) sizes nothing, yet config.json, SPEC §6.1, DESIGN and the installer's default config still carry it. Decide after 059 (resize) whether it becomes the default width or goes away, and make every place agree.

## Scope
In: `src/main/config.ts` DEFAULTS/validation, `src/shared/types.ts`, the installer's `defaultConfig()` in `steps.mjs`, SPEC amendment, DESIGN config section; tests that pin it.
Out: rewriting users' existing config.json files (an unknown key only warns).

## Done when
- [ ] `npx vitest run test/unit/config.test.ts test/unit/installer-steps.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] `grep -rn panelWidth src plugin` matches the decision (gone, or used for the default width)

## Tests
Command: `npx vitest run test/unit/config.test.ts test/unit/installer-steps.test.ts`
- "DEFAULTS match the SPEC" — proves the key's new status
- "an existing config.json with panelWidth loads" — proves old files still load (a warning at most, never a crash)
- "installer default config mirrors DEFAULTS" — proves steps.mjs follows

## Spec refs
SPEC §6.1, Amendment 6; DECISIONS 2026-10-17 058.

## Notes
Waits on 059 (the resize task decides what a remembered size means).
