# 085 · answer footer shows only the model and the response time

## Objective
Eric (0.2.6), about the status line under an answer: "no need for all that info. just model and repsonse time. thats it. add to task list. rest looks fine to me." Today `statusLine` (src/renderer/renderer.ts) shows `model · TTFT n.n s · n.n s · 5h N% · 7d M%`; it should show `model · n.n s` (the last answer's total time).

## Scope
In:
- The card footer (`.status`) is the thread's model, then ` · ` and the last assistant turn's duration in seconds with one decimal (`opus · 12.3 s`); no TTFT, no usage. Before any answer: the model alone, as today.
- Usage stays where else it is shown: the tray tooltip (`snapsolve · 5h N% · 7d M%`, §3.6) is unchanged. The turn still records `ttftMs` and `usage` in thread.json (only the display changes).
- The errors e2e that asserted usage in the footer is rewritten to the new footer (it asserts the removed behaviour).
- SPEC Amendment 19 (§4 card status line); DECISIONS row.
Out: removing ttft/usage from the data model; the tray tooltip; error and warning lines on the card.

## Done when
- [ ] `npx vitest run test/e2e/errors.e2e.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e: after an answer whose turn has usage and a TTFT, the footer's text is exactly `<thread.model> · <durationMs/1000 to 1 dp> s` (read from thread.json), with no "TTFT" and no "%"

## Tests
Command: `npx vitest run test/e2e/errors.e2e.test.ts test/e2e/panel.e2e.test.ts`
- e2e (errors, replaces "footer shows the usage"): the fake reports usage `5h 12% · 7d 34%`; after the answer the footer is exactly `model · n.n s` matching thread.json's model and the last assistant turn's durationMs; it contains neither "TTFT" nor "%" nor "5h"; a logged-in claude still raises no startup notice
- e2e (errors): the tray tooltip still carries the usage after that answer (`snapsolve · 5h 12% · 7d 34%`), if reachable from the test hook; else the existing tray unit test covers it unchanged
- e2e (panel): after a follow-up, the footer shows the newest answer's time (two turns, the second's durationMs), not the first's
- edge: a thread with no assistant turn yet shows the model alone (no " · ")

## Spec refs
SPEC §4 (card status line), §3.6; Amendment 19.

## Notes
Eric 2026-10-23 (chat), quoted in Objective. The screenshot attached to the message showed two list rows ("Data engineering and SQL", "Classical ML and statistics") rather than the footer; the footer is the only place the panel shows the model, so it is read as the footer.
