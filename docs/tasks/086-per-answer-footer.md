# 086 · per-answer footer: the model that wrote each answer (e.g. Opus 5.5) and its time

## Objective
Eric (0.2.7): "the Opus and then the latency time. Opus should display what model, and It should be per prompt. Right now, I think it's bounded to right above the text box where I type in, because when a new result is spinning up, I still see the previous message's model as well as time." Today one `.status` line per chat sits below all its turns and shows the thread's configured alias (`opus`) and the last answer's time, so while a new answer streams it still shows the previous one's. Each answer should carry its own line, under that answer, naming the model that actually answered.

## Scope
In:
- Record the model claude reports in its `system/init` event (stream.ts already parses `model`) on each assistant turn as `model` (thread.json; old turns without it fall back to the thread's alias).
- Under each finished answer: `<model name> · <that turn's time> s`. The name is readable: `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-5-5` → `Sonnet 5.5`, `claude-fable-5-1` → `Fable 5.1`; a trailing context tag like `[1m]` is dropped; anything else is shown as given.
- While an answer is thinking or streaming it has no footer; earlier answers keep theirs. The chat-wide `.status` line goes away.
- An errored turn shows its error as today, without a footer.
- SPEC Amendment 20 (replaces Amendment 19's single footer); DECISIONS row; the 085 footer tests move to the per-answer footer.
Out: the tray tooltip (usage stays there); TTFT or usage in the footer.

## Done when
- [ ] `npx vitest run test/unit/stream.test.ts test/unit/runner.test.ts test/e2e/panel.e2e.test.ts test/e2e/errors.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e: two answers in one chat each have their own footer under them with their own time; while the second is thinking, only the first answer has a footer
- [ ] e2e: with the fake reporting `claude-opus-5-5` in its init event, the footer reads `Opus 5.5 · n.n s`

## Tests
Command: `npx vitest run test/unit/stream.test.ts test/unit/runner.test.ts test/e2e/panel.e2e.test.ts test/e2e/errors.e2e.test.ts`
- unit (runner): the init event's model is saved on the assistant turn; no init model → the turn has none
- unit (display name): `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-5-5[1m]` → `Sonnet 5.5`, `claude-haiku-5-5` → `Haiku 5.5`, `opus` → `opus`, `gpt-x` → `gpt-x`
- e2e (panel): capture, follow-up with a slow fake (FAKE_DELAY_MS) and FAKE_DURATION_STEP_MS → while the second is thinking: one footer, under answer 1, `… · 1.2 s`; after: two footers, `… · 1.2 s` and `… · 3.2 s`, each directly after its answer
- e2e (errors): the fake's init model `claude-opus-5-5` (new fake option) → footer `Opus 5.5 · n.n s`, no TTFT, no usage
- edge: an old thread.json whose turns have no model → footer uses the thread's alias
- edge: an errored turn → error text, no footer

## Spec refs
SPEC §4, Amendments 19, 20; tasks 085.

## Notes
Eric 2026-10-23 (chat), quoted in Objective.
