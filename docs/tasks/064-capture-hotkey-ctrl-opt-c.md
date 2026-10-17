# 064 · hotkeys: capture default Control+Alt+C (was Control+Alt+Q)

## Objective
Eric (2026-10-17, DECISIONS hotkeys row): "screenshot should be ctrl+opt+c". Make `Control+Alt+C` the shipped default for `hotkeys.capture`. His own config.json was already switched by hand the same day, so this is about the default for new installs and every place that names the key.

## Scope
In: `src/main/config.ts` DEFAULTS; `plugin/skills/snapsolve/scripts/steps.mjs` default config; `plugin/skills/snapsolve/SKILL.md` (install, doctor question, AltGr note); installer output text; tests that pin the old key (config, hotkeys, macos, skill, installer-commands, tray fixtures where they assert the default); a SPEC amendment for §Goals/§1 hotkey lines and DESIGN D9 note. Check Ctrl+Option+C has no macOS default binding.
Out: `hotkeys.append` (unchanged until Eric decides; see 2026-10-17 chat about whether append is needed); existing users' config.json values (kept as written).

## Done when
- [ ] `npx vitest run test/unit/config.test.ts test/unit/hotkeys.test.ts test/unit/macos.test.ts test/unit/skill.test.ts test/unit/installer-commands.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] `grep -rn "Control+Alt+Q\|Ctrl+Option+Q\|Ctrl+Alt+Q" src plugin` shows only the append key (`Shift+Q`) or nothing

## Tests
Command: `npx vitest run test/unit/config.test.ts test/unit/hotkeys.test.ts test/unit/macos.test.ts test/unit/skill.test.ts test/unit/installer-commands.test.ts`
- "default capture hotkey is Control+Alt+C" — proves config DEFAULTS and the installer's default config.json
- "a user's existing capture value is kept" — proves install/update never rewrite hotkeys.capture
- "SKILL.md install and doctor name Ctrl+Option+C" — proves the user-facing text
- "taken-key notification names Ctrl+Option+C" — proves the label path with the new default

## Spec refs
SPEC §Goals hotkey line, §5 config; DESIGN D9; DECISIONS 2026-10-13 init hotkey row (superseded).
