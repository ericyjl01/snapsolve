# 040 · quitAndWait tasklist tests: advancing fake clock so a regression fails cleanly

## Objective
The 035 review found that the win32 default-`isRunning` tests in `test/unit/installer-steps.test.ts` ("tasklist lists another image that merely contains the name", "tasklist does not list it", "tasklist itself fails") pass `now: () => 0` with a no-op `sleep`. If `processRunning` regressed (e.g. dropped the quotes around the image name), quitAndWait would poll forever and the vitest worker would die out of memory (exit 134) instead of failing with an assertion.

## Scope
In:  those three tests in `test/unit/installer-steps.test.ts` use an advancing fake clock (as the `quitAndWait` describe's `clock()` helper does), so a regression ends with quitAndWait's "still running" error and a clean assertion failure.
Out: any change to `steps.mjs`.

## Done when
- [ ] task tests pass; with `processRunning`'s quotes removed in a scratch copy, the "merely contains the name" test fails by assertion within the default test timeout (no OOM)

## Tests
Command: `npx vitest run test/unit/installer-steps.test.ts`
- the three tests use an advancing clock and still assert exactly the tasklist-only call list.

## Spec refs
DESIGN §4.3.

## Notes
From the 035 review (2026-10-14), recorded as non-blocking.
