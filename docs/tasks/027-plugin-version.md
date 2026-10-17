# 027 · Plugin version vs the claude-skills convention

## Objective
Settle whether the released `plugin.json` carries a `version`. DESIGN §5 (and 022) set it to the app version; the claude-skills README says "`version` is intentionally omitted everywhere — every merged commit is a new SHA-based version, so `/plugin update` always pulls the latest", and none of its seven plugins sets one.

## Scope
In:  Eric's answer as a DECISIONS row; if he picks "omit": `scripts/release.mjs` writes `plugin.json` without `version` (the app version stays in `app/package.json`, which gates installer updates and the same-version refusal), its tests and DESIGN §5 updated.
Out: anything else in the release script.

## Done when
- [ ] DECISIONS row with Eric's answer; if "omit": task tests pass with a test that the released `plugin.json` has no `version` key

## Tests
Command: `npx vitest run test/unit/release.test.ts`
- (only if "omit") released `plugin.json` has no `version`; `app/package.json` version still equals the root version; the same-version-different-app refusal still holds.

## Spec refs
DESIGN §5; claude-skills `README.md` (Plugins section, last paragraph); Claude Code docs plugins/loading "How Claude Code computes the version" (a pinned `version` keeps marketplace users on the cached copy until it changes).

## Notes
Found while starting 022 (2026-10-14). Effect: with a local-path marketplace (the claude-setup-source zip) plugins load in place and `version` changes nothing; with the GitHub marketplace a pinned version holds users on the cached copy until it changes, so a SKILL.md fix without an app version bump would not reach them. Recommended: omit (Eric's convention; the installer reads the app version from `app/package.json`, not `plugin.json`).
