# 015 · Restore npm test as the full-suite gate and re-run e2e

## Objective
Undo the temporary unit + integration gate (DECISIONS 2026-10-13, user-approved option A) once Electron can launch on this PC, and prove every task closed under it against the e2e suite.

## Precondition (check first, change nothing until it holds)
`node -e "console.log(require('child_process').spawnSync(require('electron'),['--version']).error?.code ?? 'ok')"` must print `ok`. If it prints `EPERM`, Defender ASR still blocks electron.exe (DESIGN §10 risk 6): `tasks.py block 015 "Electron still blocked by Defender ASR rule 01443614 — IT exclusion or Microsoft submission needed; how to proceed?"` and move on.

## Scope
In:  `.claude/memory/keel.json` `test_command` back to `npm test`; `test/unit/harness.test.ts` expects `npm test` again (drop the temporary comment); a full `npm test` run.
Out: fixing e2e failures caused by tasks closed under the temporary gate — each becomes its own `tasks.py add` task (a dep of 009).

## Done when
- [ ] the precondition prints `ok`
- [ ] `.claude/memory/keel.json` `test_command` is `npm test`
- [ ] `npm test` exits 0 (unit + integration + e2e)

## Tests
Command: `npx vitest run test/unit/harness.test.ts test/e2e/launch.e2e.test.ts`
- harness "sets keel's full-suite command …" expects `npm test` — fails while keel.json holds the temporary command (this is the red).
- launch.e2e — the built app starts, reports its name, receives SNAPSOLVE_DATA_DIR and exits cleanly; proves Electron launches again.

## Spec refs
SPEC §M1; DESIGN §10 risk 6; docs/issues.md "ASR rule blocks electron.exe".

## Notes
009 and 014 depend on this task; 010, 011 and 013 follow through 009.
2026-10-14: the precondition still prints EPERM on the Windows PC (Defender ASR rule 01443614-cd74-433a-b99e-2ecdc07bfc25 blocks node_modules\electron\dist\electron.exe; docs/issues.md "ASR rule blocks electron.exe"). Eric: finish this task on a Mac (DECISIONS 2026-10-14). On the Mac: `npm ci`, run the precondition, then the Scope as written; the first `npm test` there is also the first e2e run of everything closed under the temporary gate (003–008, 016).
