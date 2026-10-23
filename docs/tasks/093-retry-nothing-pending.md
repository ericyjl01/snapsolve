# 093 · Retry with nothing to re-run leaves the card Thinking…

## Objective
Found in 088: the renderer puts a thread in its `pending` set when Retry is clicked and clears it only on `answer:done` or a rejected `api.retry`. `app.handlers.retry` returns quietly when there is nothing to re-run (`app.retryNothing`: e.g. a thread recovered as `error` with no user turn, 052) or the thread is not errored (`app.retryIgnored`), so the card then says "Thinking…" until something else ends a turn in it.

## Scope
In:  a Retry that queues nothing leaves the card as it was (not "Thinking…"): main rejects (or answers) so the renderer clears `pending`, or the Retry button is not offered for a thread with nothing to re-run.
Out: changing what Retry re-runs (050).

## Done when
- [ ] `npx vitest run test/unit/app.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green

## Tests
Command: `npx vitest run test/unit/app.test.ts test/e2e/panel.e2e.test.ts`
- unit: retry on an errored thread with no user turn → the renderer is told it did nothing (rejects / returns false); nothing queued
- unit: retry on a thread that is not errored → same
- e2e: a recovered thread with no user turn shows no Retry, or a click on it does not leave "Thinking…"

## Spec refs
SPEC §4.2; tasks 050, 052.

## Notes
Found while designing 088's failed-save card (DECISIONS 2026-10-23 088, second row).
