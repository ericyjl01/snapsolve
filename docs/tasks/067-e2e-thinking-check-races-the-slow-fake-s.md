# 067 · e2e: Thinking… check races the slow fake's first piece (panel e2e)

## Objective
`test/e2e/panel.e2e.test.ts` "captureFromFile opens the panel unfocused with Thinking…" failed once (1 in 4, task 059): its `.answer` count was 1 at the no-answer check, because the slow fake's first piece arrives 500 ms after spawn and a cold first window can show Thinking… later than that (docs/issues.md 2026-10-17 task 059). Make the check deterministic without weakening it.

## Scope
In: that test (and the fake claude's per-test env if needed, e.g. a longer delay before the first piece).
Out: app code (the renderer order is correct; only the test's timing assumption is not).

## Done when
- [ ] `npx vitest run test/e2e/panel.e2e.test.ts` exits 0 ten times in a row (loop, Mac awake)
- [ ] `npm test` exits 0

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- "captureFromFile opens … Thinking…" — still proves Thinking… shows before any answer, now independent of window start-up time

## Spec refs
SPEC §4.2 (Thinking… before Claude answers).

## Notes
