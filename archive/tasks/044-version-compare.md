# 044 · doctor and update compare versions the same way (pre-release, unparsable)

## Objective
`doctor` (`commands.mjs` `compareVersions`) parses only `x.y.z`, ignores pre-release tags and returns NaN for anything else, which falls through to "installed is newer than the plugin's"; `update` compares the raw strings. Installed `0.2.0-beta.1` vs plugin `0.2.0`: doctor says "(the plugin's version)" while update reinstalls. (From the 2026-10-15 /code-review, finding 8; Eric: "do 8".)

## Scope
In:  one `compareVersions` exported from `steps.mjs` (SemVer precedence: pre-release lower than its release, identifiers compared numerically or lexically; build metadata ignored; null for unparsable), used by `preflight`'s Node check, `doctor` and `update`. `update` is "up to date" exactly when the compare is 0; doctor's unparsable case warns that it cannot compare and names `/snapsolve update`. The duplicate in `commands.mjs` is removed.
Out: other shared helpers (045).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts test/unit/installer-steps.test.ts`
- compareVersions: `0.2.0-beta.1` < `0.2.0`; `0.2.0-beta.2` > `0.2.0-beta.1`; `0.2.0-beta.10` > `0.2.0-beta.9`; `1.0.0+build.5` = `1.0.0`; `v22.12.0` vs `22.12.0` = 0; `garbage` → null.
- doctor: installed `0.2.0-beta.1`, plugin `0.2.0` → warn names `/snapsolve update`; installed `0.3.0` → "newer"; unparsable installed version → a warn saying it cannot compare, not "newer".
- update: installed `0.2.0-beta.1`, plugin `0.2.0` → updates; installed `0.2.0+b1`, plugin `0.2.0` → "up to date".
- preflight's Node floor check unchanged (existing tests stay green).

## Spec refs
DESIGN §4.3 (update), §4.5 (doctor).

## Notes
Filed 2026-10-15 from /code-review all.
