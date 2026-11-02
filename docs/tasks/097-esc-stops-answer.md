# 097 · Esc stops an answer that is being written (a chatbot's stop)

## Objective
Eric (2026-11-02, chat, before his General Magic call): "escape key shoulkd be use to cancle any prompt send jsut as in any chat bot" (with the voice hold-to-talk change, task 096). Then: "log the tasks list. we will built in new session."

Today: Esc with the window focused hides the window (`src/main/panel.ts`, SPEC Amendment 3); Esc while listening cancels dictation (task 063). There is no way to stop an answer once claude is running: the runner only kills claude on its timeout (`src/main/runner.ts`, `timeoutSec`).

## Scope
In (proposed; confirm with Eric first, the brainstorm is still open):
- Esc while the chat on screen has an answer in flight (thinking or streaming): stop it. The runner kills that turn's claude (SIGTERM, then SIGKILL like the timeout path) and the turn ends as stopped.
- What the stopped turn shows (Eric's call): keep the text written so far with a "Stopped" mark, as ChatGPT/Claude do (proposed), or drop it. Retry works on it either way.
- Esc with nothing in flight: unchanged (hides the window). Esc while listening: unchanged (cancels dictation).
- A follow-up after a stopped turn continues the chat (session resume or fallback as today).
- SPEC amendment (next free number), DECISIONS row quoting Eric.
Out: a stop button in the UI unless Eric asks (proposed: maybe the send button turns into stop while answering, as chatbots do).

## Done when
- [ ] Esc during "Thinking…" or streaming stops claude within about a second; the card shows the chosen stopped state; the chat accepts the next question.
- [ ] Esc with nothing running still hides the window; Esc while dictating still cancels dictation.
- [ ] Unit suite green (`npx vitest run --project unit`), build ok, caps ok; e2e only when Eric says windows are OK; an Opus review passes.

## Tests
Command: `npx vitest run --project unit test/unit/runner.test.ts test/unit/panel.test.ts test/unit/app.test.ts`
- runner.stop(threadId) on a running turn: the child gets SIGTERM, then SIGKILL if it ignores it; the turn is saved stopped (partial text kept or dropped, as decided); a queued turn behind it is not started by the stop alone.
- stop with nothing running: no-op, no error; stop on another chat's thread leaves the running one alone.
- the stopped turn's retry target re-runs the same question; a follow-up after it resumes the session.
- panel: Esc with an answer in flight calls stop and does not hide; Esc with none hides (unchanged); Esc while listening cancels voice (unchanged).
- no transcript or prompt text in any log line for the stop.

## Spec refs
SPEC Amendment 3 (Esc hides), Amendment 11 (voice Esc), §3 runner, §7.1.

## Notes
- Build on branch `worktree-answer-mode` in `.claude/worktrees/answer-mode` by hand like 089; no `npm test`, no e2e runs (windows pop up on Eric's screen).
- Esc reaches main only while the window has focus (before-input-event); while it is unfocused only the voice Esc shortcut exists. Whether Esc should stop an answer when the window is not focused (a global Esc while answering) is a question for Eric: a global Esc steals the key from every app.
