# 099 · Queue a question asked during an answer; queued ones show at once

## Objective
Eric (2026-11-03, chat, after hand-checking 089/096/097/098): "Is there awnyway we can q a message when its repsonding? ciurrentl it says wait". Asked whether a new question should wait or replace the answer being written: "wait for the first question to finish  and then answer the second one." (DECISIONS 2026-11-03 099).

Before: a typed follow-up during an answer already waited in the runner's queue, but showed nowhere until its turn started; ⌃⌥V, ⌃⌥B and the mic buttons refused with "Wait for the answer, then ask." (063's `VOICE_BUSY_NOTE`, `app.isAnswering`).

## Scope
In:
- Voice and listen (⌃⌥V, ⌃⌥B, mic buttons) work while the chat on screen is thinking or answering: the dictation runs as when idle and its text is queued behind the answer, in order. `VOICE_BUSY_NOTE` and the press refusal are gone.
- A question queued behind a running answer (typed, dictated or heard) shows in that chat at once, after the answer being written, faded, with its mic or speaker mark and a small "Queued" label; it becomes a normal question when its turn starts (the saved user turn replaces it). Several queue in the order asked.
- Esc still stops only the answer being written (097); the queued questions then run, in order.
- Claude's calls: the queued list is not saved (a quit drops what has not started, as today); a queued question cannot be edited or removed (out); the list rides on the thread snapshots main already sends (no new preload function).
Out: cancelling or editing a queued question; a question replacing the running answer (Eric chose wait); queueing across chats (each chat its own queue, as today).

## Done when
- [x] Holding ⌃⌥V or ⌃⌥B during an answer listens and, on let go, queues the question; no "wait" note (unit: voice.test, app.test).
- [x] A question sent during an answer appears in the chat at once as queued, and runs after the answer (unit: runner.test, app.test; e2e written).
- [x] Unit suite green (`npx vitest run --project unit`: 1249 passed, 7 skipped), build ok, typecheck ok, caps ok; e2e written (`queued questions (e2e, 099)`), not run unless Eric says.
- [x] An Opus review passes (review 1 pass, 2026-11-03; notes below).

## Tests
Command: `npx vitest run --project unit test/unit/voice.test.ts test/unit/runner.test.ts test/unit/app.test.ts test/unit/ipc.test.ts`
- voice.test: a press (key, button, listen) while answering spawns the helper as when idle (no busy note); the 063 busy test replaced; letting go sends as usual.
- runner.test: a follow-up enqueued while the chat runs is listed as queued (text and its voice/heard mark) for that chat, in order; leaves the list when its turn starts (before its user turn is saved and announced, so it never shows twice); a stop (097) or a failure of the running answer leaves the queued ones to run in order; another chat's queue is separate; a retry or screenshot waiting is not a queued question.
- app.test: a typed, dictated or heard follow-up while running is enqueued (not refused) and the broadcast thread carries `queued` with it; the list empties when it starts; `isAnswering` no longer gates voice.
- e2e (not run): type a question while an answer streams → a faded `.question.queued` with "Queued" after the answer; then it becomes a normal question and is answered.

## Spec refs
SPEC Amendments 11, 27, 28, 29, 30 (this task); §3.5 concurrency.

## Notes
- Tests bd774ac (red: 10 failed in runner/app; voice.test failed on the removed isAnswering dep) and 315b652 (a test that picked the wrong queued event); code e22d605.
- Also queued: a typed follow-up waiting for a slot (another chat holds the only one, maxConcurrent) is listed too.
- Hand check on Eric's Mac (checklist 032 at merge): while an answer streams, type a question and hold ⌃⌥V → both show faded with Queued under the answer, then are asked and answered in order.
- Review 1 (pass) notes, not changed: (1) when a queued question starts, its faded bubble leaves a moment before the saved question arrives (two thread.json writes between; "Thinking…" shows in the gap) — the order the Tests asked for; if it shows on the Mac, send the shorter list just before the `turn` event; (2) a question sent while a capture into the same chat is still saving can run before that screenshot → backlog 100; (3) the e2e needs the first answer still streaming when the dictation lands (~0.5 s margin at FAKE_DELAY_MS 1500): raise the delay if it flakes; (4) voice.test's `"isAnswering" in setup().deps` checks the fixture only; tsc and the VOICE_BUSY_NOTE export check enforce the removal.
