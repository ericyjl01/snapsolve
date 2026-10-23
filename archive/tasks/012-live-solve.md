# 012 · System prompt and live solve tests

## Objective
Final `prompts/system.md`, proven against real `claude` on fixture problems.

## Scope
In:  `prompts/system.md` (SPEC §3.7); `scripts/make-problem-fixtures.ps1` (System.Drawing; generates PNGs) and committed `test/fixtures/problems/{algebra,rates,code-bug,multiple-choice}.png` + `expected.json`; `vitest.live.config.ts`; `test/live/solve.live.test.ts` driving the real runner (real `claude`, opus/high) on each fixture; `docs/live-results.md` with one sonnet/high run per fixture (informational).
Out: UI.

## Done when
- [ ] `npm run test:live` passes twice in a row
- [ ] `docs/live-results.md` records opus and sonnet answers, latency, correctness
- [ ] DESIGN.md §10 item 5 updated with the sonnet result

## Tests
Command: `npx vitest run --config vitest.live.config.ts`
- algebra (`3(x − 4) + 2x = 2x + 9`) → contains `x = 7`.
- rates (pipes 6 h, 9 h, drain 12 h) → contains `36/7` or `5 h 9 min`/`5 hours 9 minutes` (8.57 min accepted).
- code-bug (off-by-one in a Python loop) → names the faulty line and shows a corrected fenced code block.
- multiple-choice → names the correct letter.
- format: first non-empty line contains the answer token; no preamble ("Sure", "Let's", "Here's"); under 25 lines; no `<img`/raw HTML.
- turn completes under 60 s; `result.is_error` false.

## Spec refs
SPEC §3.1, §3.7.

## Notes
Consumes plan usage (~$0.04 API-equivalent per fixture on Opus/high); never part of `npm test`.
