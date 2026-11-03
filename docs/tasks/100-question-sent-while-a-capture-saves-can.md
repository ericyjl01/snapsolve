# 100 · Question sent while a capture saves can run before its screenshot (099 review)

## Objective
Found by 099's review 1 (2026-11-03): app.onCapture shows the chat at once and enqueues the screenshot only after its PNG is made and saved (088, `saveShot`). A question that arrives in that gap (typed, or now — since 099 removed the 063 busy gate — dictated or heard) is enqueued first, so it runs before the screenshot it was probably about. Typed follow-ups could already do this before 099; for voice it needs a hold of 300 ms+ to end inside the save, so it is unlikely.

## Scope
In: a question sent to a chat whose capture is still being saved runs after that screenshot's turn (e.g. app holds such questions until the screenshot is enqueued, or the runner orders them).
Out: anything else about queueing (099).

## Done when
- [ ] A question sent while a capture into the same chat is saving is enqueued after the screenshot (unit: app.test).

## Tests
Command: `npx vitest run --project unit test/unit/app.test.ts`
- app.test: a save that waits; onVoice / followUp during it → enqueue order screenshot, then question; a failed save still lets the question run.

## Spec refs
SPEC Amendment 30, §2.1, task 088.

## Notes
Backlog; Eric decides whether it is worth doing.
