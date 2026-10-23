# 057 · flaky panel e2e: continued-note wait times out (panel.e2e.test.ts:205)

## Objective
The full-suite gate must be deterministic. 055's reviewer saw `test/e2e/panel.e2e.test.ts:205` (the 051 "append past maxScreenshotsPerThread shows CONTINUED_NOTE" test) time out on its 10 s wait for the `.note` on the continued thread's card: 1 of 3 full `npm test` runs, 1 of 3 runs of the file alone, on master (pre-existing; not caused by 055). Find the root cause (app: the seeded thread's card rendered before/without its note, or the note event lost; or test: the locator/wait races the panel's thread view) and fix it in the code, not by loosening the wait.

## Scope
In:  the 051 continued-thread path (app.ts append → store seed → panel thread view/card note) and the e2e test's waits; a deterministic reproduction.
Out: other e2e tests unless they share the same root cause (then a separate task); raising timeouts as the fix.

## Done when
- [x] the root cause is named in docs/issues.md with the evidence
- [x] `npx vitest run test/e2e/panel.e2e.test.ts` passes 10 runs in a row (`for i in $(seq 10); do npx vitest run test/e2e/panel.e2e.test.ts || break; done`)
- [x] `npm test` exits 0

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- a deterministic test for the race found (e.g. the seeded thread's note shows even when its card is rendered before the seed event arrives / when the panel view refreshes mid-append) — proves the note is not lost under the ordering that caused the flake; written once the cause is known (superpowers:systematic-debugging first)

## Spec refs
SPEC §4.3 (thread view), DECISIONS row for 051 (continued threads).

## Notes
Found by 055's reviewer, 2026-10-17. Use systematic debugging: reproduce with repeated runs and app logs before touching code.
2026-10-17: two causes (docs/issues.md 057). (1) the seeded user turn reached the card only at answer:done → runner `turn` event + app broadcast (46f93ef). (2) the 051 (and new 057) e2e waited on `.answer`, which also matches the streaming node, so the append could run before the first answer was saved → unseeded thread, no note (dbc899b). Done-when: 10/10 panel e2e runs (12–14 s each, under `caffeinate -dims` — the lid-closed Mac otherwise sleeps mid-run and hangs tests 150–900 s); task tests 107/107; npm test 793 passed.
