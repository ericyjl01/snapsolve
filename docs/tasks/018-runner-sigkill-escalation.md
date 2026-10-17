# 018 · Runner: escalate a timed-out turn to SIGKILL on macOS

## Objective
A timed-out turn never leaves `claude` running: if the process has not exited within the grace period after `kill()`, the runner sends SIGKILL (SPEC §3.5).

## Scope
In:  `src/main/runner.ts` timeout path (after `KILL_GRACE_MS` without `close`: `child.kill("SIGKILL")`, then settle); `test/unit/runner.test.ts`.
Out: process-tree killing, Windows changes (`kill()` already terminates there), other timeout behavior.

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/runner.test.ts`
- a fake child that ignores the first `kill()` → after the grace period the runner calls `kill("SIGKILL")`; the turn errors `timeout` with retry and the queue moves on.
- a fake child that exits on the first `kill()` → no SIGKILL is sent.
- a child that closes between SIGTERM and the grace timer → settled once, no SIGKILL, no double `error` event.

## Spec refs
SPEC §3.5; 006 review note (2026-10-14).

## Notes
006 review: after a timeout runner.ts sends one `kill()` (SIGTERM) and settles after a 5 s grace without escalating; on macOS a `claude` that ignores SIGTERM could outlive its turn. Windows `kill()` always terminates. Use fake timers or a small injectable grace so the test does not wait 5 s.
