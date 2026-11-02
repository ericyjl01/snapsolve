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
- [x] Unit suite green (`npx vitest run --project unit`: 1192 passed, 7 skipped), build ok, caps ok; e2e written but not run (windows pop up; Eric says when).
- [ ] An Opus review passes.

## Tests
Command: `npx vitest run --project unit test/unit/runner.test.ts test/unit/panel.test.ts test/unit/app.test.ts test/unit/errors.test.ts`
- runner.test stop: a running turn → SIGTERM, saved as errored `stopped` with the streamed text (whole turn), status error, one error event with retry; text after the stop neither streamed nor kept; a claude ignoring SIGTERM gets SIGKILL after the stop grace and the queue moves on; one that never closes is settled at the SIGKILL; a second stop → still true, one SIGTERM; nothing running / another chat / after the answer → false, nothing changes; a chat only queued → false, still runs; a question queued behind the stopped turn runs after it (turn order kept); stopped while preparing (answer prompt pending) → no claude, stopped with no text; retry target and Retry re-run it; a follow-up resumes the adopted transcript; no answer text, question or prompt in the log, `runner.stop` logged.
- app.test stopAnswer: the capture's chat is stopped; false when nothing runs; after "+" false, runner not asked; a chat chosen in the sidebar; after a restart the newest chat, never a permission card; no chats → false.
- panel.test: Esc with onEscape true → stays, no onClose; then false → hides; auto-repeat → neither; key-up, other keys, hidden → onEscape not asked.
- errors.test: `stopped` → "Stopped.".
- e2e (not run): Esc while streaming ("hang" scenario) → `.partial.stopped` "Answer", "Stopped.", Retry, window visible, no error dot, thread.json turn; a follow-up is answered; Esc then hides. Esc during Thinking… → Stopped with no text; Retry answers.

## Spec refs
SPEC Amendment 3 (Esc hides), Amendment 11 (voice Esc), Amendment 28, §3 runner, §7.1.

## Notes
- Built on branch `worktree-answer-mode` in `.claude/worktrees/answer-mode` by hand like 089 (tests 2e3185d, red: 22 failed; code 9dbbd80). No `npm test`, no e2e runs.
- Hand check on Eric's Mac (checklist 032 at merge): ask something long, click into the window, Esc while it writes → it stops within a second, text kept with "Stopped." and Retry; Esc again → hides.
