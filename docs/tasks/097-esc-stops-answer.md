# 097 · Esc stops an answer that is being written (a chatbot's stop)

## Objective
Eric (2026-11-02, chat, before his General Magic call): "escape key shoulkd be use to cancle any prompt send jsut as in any chat bot" (with the voice hold-to-talk change, task 096). Then: "log the tasks list. we will built in new session." In the new session, asked the open questions: "just go" (the calls below are Claude's; DECISIONS 2026-11-02 097).

Before: Esc with the window focused hid the window (`src/main/panel.ts`, SPEC Amendment 3); Esc while listening cancelled dictation (task 063). There was no way to stop an answer once claude was running: the runner only killed claude on its timeout (`src/main/runner.ts`, `timeoutSec`).

## Scope
In (SPEC Amendment 28):
- Esc with the window focused while the chat on screen has an answer in flight (thinking or streaming): stop it. `runner.stop(threadId)`: SIGTERM, then SIGKILL after 1 s (`stopGraceMs`); a turn still being prepared never starts claude; text after the stop is dropped.
- The stopped turn (Claude's call, as ChatGPT/Claude do): an errored answer of kind `stopped` keeping the text written so far, unfaded, with a muted "Stopped." and Retry (re-runs the same question in place); the sidebar dot is not the error colour. The window stays.
- "The chat on screen": main's current chat; before one is chosen or captured into, the newest (permission cards aside); none after "+" (`app.stopAnswer`).
- Esc with nothing running there: unchanged (hides the window); Esc auto-repeats do nothing. Esc while listening: unchanged (cancels dictation; main asks `stopAnswer` only while voice is idle).
- Nothing queued is dropped: a question waiting behind the stopped turn runs after it; a chat only waiting for a slot is not stopped (Esc hides).
- A follow-up after a stopped turn continues the chat (session resume or fallback as today).
Out: a stop button in the UI; a global Esc while the window is not focused (it would take the key from every app).

## Done when
- [x] Esc during "Thinking…" or streaming stops claude within about a second; the card shows the stopped state; the chat accepts the next question. (unit: runner.test stop, app.test stopAnswer, panel.test; e2e written, not run)
- [x] Esc with nothing running still hides the window; Esc while dictating still cancels dictation. (unit: panel.test; the voice path is unchanged, 063/096 tests)
- [x] Unit suite green (`npx vitest run --project unit`: 1196 passed, 7 skipped after review 1), build ok, caps ok; e2e written but not run (windows pop up; Eric says when).
- [x] An Opus review passes (review 1 fail, two reasons fixed; review 2 pass).

## Tests
Command: `npx vitest run --project unit test/unit/runner.test.ts test/unit/panel.test.ts test/unit/app.test.ts test/unit/errors.test.ts`
- runner.test (review 1): with the default grace a claude ignoring SIGTERM gets SIGKILL about 1 s after the stop (950–2500 ms, not 5 s); an error result printed on the way out is still stopped and claude auth status is not asked; a resumed turn stopped before any text whose claude then says "No conversation found" starts no fallback.
- panel.test (review 1): a throwing onEscape is logged (`panel.escapeFailed`) and the window hides.
- runner.test stop: a running turn → SIGTERM, saved as errored `stopped` with the streamed text (whole turn), status error, one error event with retry; text after the stop neither streamed nor kept; a claude ignoring SIGTERM gets SIGKILL after the stop grace and the queue moves on; one that never closes is settled at the SIGKILL; a second stop → still true, one SIGTERM; nothing running / another chat / after the answer → false, nothing changes; a chat only queued → false, still runs; a question queued behind the stopped turn runs after it (turn order kept); stopped while preparing (answer prompt pending) → no claude, stopped with no text; retry target and Retry re-run it; a follow-up resumes the adopted transcript; no answer text, question or prompt in the log, `runner.stop` logged.
- app.test stopAnswer: the capture's chat is stopped; false when nothing runs; after "+" false, runner not asked; a chat chosen in the sidebar; after a restart the newest chat, never a permission card; no chats → false.
- panel.test: Esc with onEscape true → stays, no onClose; then false → hides; auto-repeat → neither; key-up, other keys, hidden → onEscape not asked.
- errors.test: `stopped` → "Stopped.".
- e2e (not run): 058 and 059 wait for the answer before their Esc (it would stop it now). Esc while streaming ("hang" scenario) → `.answer.stopped` "Answer" at full opacity, not `.partial`, "Stopped.", Retry, window visible, no error dot, thread.json turn; a follow-up is answered; Esc then hides. Esc during Thinking… → Stopped with no text; Retry answers.

## Spec refs
SPEC Amendment 3 (Esc hides), Amendment 11 (voice Esc), Amendment 28, §3 runner, §7.1.

## Notes
- Built on branch `worktree-answer-mode` in `.claude/worktrees/answer-mode` by hand like 089 (tests 2e3185d, red: 22 failed; code 9dbbd80). No `npm test`, no e2e runs.
- Review 1 (fail): e2e 058/059 pressed Esc while the slow fake answer streamed (now a stop, the window stayed); the 1 s stop grace had no test (all overrode it). Fixed in tests 96dfceb (red: 1 failed, the auth recheck; the rest guard behavior that already held) and code 51a468a, with notes taken: the stopped text is drawn as `.answer.stopped` (keeps code-block and math styles; was a faded `.partial`), no `claude auth status` recheck on a stop. Not changed (notes): a stop after the timeout's kill began still ends as timeout; a stop landing after claude closed but before the turn is saved keeps the window up for that press; main.ts's voice-idle condition is covered only by reading (no e2e takes the global Esc away).
- Review 2 notes, not done (follow-ups): pin `!attempt.stopped` before the resume fallback (assert sessionId/transcriptPath unchanged after a stopped resume) and `entry.kill = undefined` (a stop after claude exited keeps a finished answer); Esc in the sub-second "Thinking…" before the runner has the turn hides instead of stopping; on a first turn the red "Something went wrong." flashes for one disk write before the stopped turn arrives (pre-existing ordering in renderer `update`).
- Hand check on Eric's Mac (checklist 032 at merge): ask something long, click into the window, Esc while it writes → it stops within a second, text kept with "Stopped." and Retry; Esc again → hides.
