# 047 · runner.turnFailed never logs streamed answer text

## Objective
`attemptError` (`src/main/runner.ts`) builds the error message from `result.result` (else `errors`, else the stderr tail), and `fail()` logs it as `runner.turnFailed`. When a turn streamed an answer and then ended `is_error: true`, `result.result` is that answer, so answer text lands in snapsolve.log, against ARCHITECTURE `## Do NOT` and SPEC §5.1. (From the 2026-10-15 /code-review, finding 7; Eric: "do 7".)

## Scope
In:  when the attempt streamed answer text (`sawText`), the error message leaves out `result.result` and uses `errors` and the stderr tail, plus the result's length (`result: <n> chars omitted`); classification (usageLimit, notLoggedIn, internal) still sees the full text in memory. Turns that streamed nothing keep logging Claude's own error text (needed to diagnose login/usage errors).
Out: what the card shows (fixed messages, unchanged); other log events.

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes

## Tests
Command: `npx vitest run test/unit/runner.test.ts`
- deltas "SECRET-ANSWER" streamed, then `result` `is_error: true` with `result: "SECRET-ANSWER"` → the log has no "SECRET-ANSWER"; `runner.turnFailed` names the omitted length; the card shows the fixed internal message.
- same, with `errors: ["overloaded"]` → the log contains "overloaded" but not the answer.
- streamed text, then a usage-limit result text → still classified usageLimit; the answer text is not logged.
- nothing streamed, "Not logged in · Please run /login" → logged as today (existing test stays green).

## Spec refs
SPEC §5.1; ARCHITECTURE `## Do NOT`; DECISIONS 2026-10-14 (006).

## Notes
Filed 2026-10-15 from /code-review all.
