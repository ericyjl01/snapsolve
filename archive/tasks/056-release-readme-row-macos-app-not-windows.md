# 056 · release README row: macOS app, not 'Windows desktop app' (Amendment 4)

## Objective
Since Amendment 4 (macOS only), the plugin's user-facing descriptions should not call snapsolve a Windows app. Two strings still do: the README row release.mjs writes and the plugin manifest description. Found in 055 and its review.

## Scope
In:  `scripts/release.mjs` README_CELLS (line ~257: "(Windows desktop app)" → "(macOS desktop app)"); `plugin/.claude-plugin/plugin.json` description ("sets up the desktop app (Windows)." → "(macOS)."); release.test.ts assertions for both; then re-run `node scripts/release.mjs --target ~/dev/snapsolve-local` and fix the existing row in `~/dev/snapsolve-local/README.md` by hand (release keeps an existing row as written).
Out: win32 code paths and their tests (kept, DECISIONS 2026-10-17 / Amendment 4); the append-only history files.

## Done when
- [ ] `npx vitest run test/unit/release.test.ts` exits 0
- [ ] `grep -n -i windows scripts/release.mjs plugin/.claude-plugin/plugin.json` shows no user-facing description text
- [ ] `~/dev/snapsolve-local/README.md` and `~/dev/snapsolve-local/plugins/snapsolve/.claude-plugin/plugin.json` say macOS

## Tests
Command: `npx vitest run test/unit/release.test.ts`
- "README row describes a macOS desktop app" — proves the row assemble() appends contains "macOS desktop app" and not "Windows"
- "released plugin.json keeps the source description" — proves the released manifest description equals plugin/.claude-plugin/plugin.json's and mentions macOS, not Windows (reads the real source manifest, not the fixture)

## Spec refs
SPEC Amendment 4; DESIGN §5.

## Notes
Reviewer of 055: plugin.json:3 also says "(Windows)".
