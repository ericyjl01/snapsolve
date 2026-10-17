# 034 · Runner test: a timed-out turn settles after SIGKILL even if claude never closes

## Objective
018 made a timed-out claude that ignores the first `kill()` get SIGKILL after the grace period, and `src/main/runner.ts` settles the turn right after `child.kill("SIGKILL")`. The 018 test's stubborn child closes on SIGKILL, so it would still pass if that `settle()` were removed: nothing proves a turn whose claude never closes (a process stuck in the kernel, a pipe held open by a grandchild) still ends, errors `timeout` and frees its queue slot.

## Scope
In:  `test/unit/runner.test.ts` "timeout escalation" describe: a child that never closes, even after SIGKILL; a close that arrives after the SIGKILL settle.
Out: any change to `src/main/runner.ts` (the behavior exists since 018); output that arrives after the SIGKILL settle (task 042).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes
- [ ] with the `settle()` after `child.kill("SIGKILL")` removed in a scratch copy, the never-closes test fails (the turn never ends) instead of passing

## Tests
Command: `npx vitest run test/unit/runner.test.ts`
- a child that never closes (no close on SIGTERM or SIGKILL) → signals SIGTERM then SIGKILL; the turn errors `timeout` with retry, one error event; a second queued turn (maxConcurrent 1) still runs and succeeds.
- a close that arrives 150 ms after the SIGKILL settle → no event is emitted after the settle; still one error event; the outcome stays `timeout`.

## Spec refs
SPEC §3.5; task 018.

## Notes
Added at the 018 close (2026-10-14) as a template; filled when Eric pulled it into M2 (2026-10-15). Test-only: the runner already settles at the SIGKILL, so a red run cannot fail; the scratch-copy check in Done-when is the evidence.
