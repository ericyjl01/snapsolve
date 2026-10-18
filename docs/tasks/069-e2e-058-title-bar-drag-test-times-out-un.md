# 069 · e2e: 058 title-bar drag test times out under load (120 s)

## Objective
`test/e2e/panel.e2e.test.ts` "title bar drag moves the window: movable, a 36 px drag-region title bar, and it reopens at the new x/y, also after a restart (058)" timed out once at its 120 s limit during 064's close prep, in a full run that took 158 s where every other run took 39–42 s (docs/issues.md 2026-10-17 task 064). The same file alone passed 10/10 in 15 s straight after, and two later full runs were green. Make that test survive a loaded machine, or prove what it is actually waiting for.

## Scope
In: that test (its waits, the drag simulation, the window.json poll), the e2e helpers it uses, and its timeout if a longer one is the honest answer.
Out: `src/main/panel.ts` and the save path (058/059 behaviour is correct and covered); 067's separate Thinking… race.

## Done when
- [ ] `npx vitest run test/e2e/panel.e2e.test.ts` exits 0 ten times in a row (loop, Mac awake)
- [ ] The same ten runs pass with the machine loaded (e.g. a parallel `npm test`), or the test fails with a message naming what it waited for instead of a bare vitest timeout
- [ ] `npm test` exits 0

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- "title bar drag moves the window … (058)" — still proves movable + the 36 px drag region + the saved rect reopening at the new x/y after a restart, now without depending on how fast the Mac is

## Spec refs
SPEC Amendment 6 (floating window, saved per display); DECISIONS 2026-10-17 058.

## Notes
Found while closing 064. Keep the working tree still while `npm test` runs: editing a memory file mid-run fails the suite's git-clean teardown, which looks like a test failure but is not.
