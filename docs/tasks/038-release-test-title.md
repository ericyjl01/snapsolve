# 038 · release.test.ts: retitle the source plugin.json no-version test

## Objective
The 027 review noted that the test "plugin/.claude-plugin/plugin.json names snapsolve and leaves version to the release" in `test/unit/release.test.ts` has a stale title: since 027 the release adds no version either. The assertion (no version in the source manifest) is right.

## Scope
In:  retitle that test (e.g. "… names snapsolve and has no version"); no assertion changes.
Out: everything else.

## Done when
- [ ] task tests pass

## Tests
Command: `npx vitest run test/unit/release.test.ts`
- the renamed test still asserts `manifest.version` is undefined and `name` is `snapsolve`.

## Spec refs
DECISIONS 2026-10-14 (027).

## Notes
Backlog; cosmetic.
