# 092 · one model encode per capture, not two (runner re-encodes the saved PNG)

## Objective
Found in 088: every capture runs `encodeForModel` twice. capture.ts makes `Screenshot.send` (resize to 2576, PNG, JPEG over 3 MB) and nothing reads it; the runner's `loadSendImage` (main.ts) then decodes the saved PNG and encodes it again before claude is spawned. Measured on Eric's Mac (3440 × 1440, 2026-10-23): `encodeForModel` ≈ 160 ms, the full `toPNG` ≈ 115 ms. Do the model encode once, so the answer starts sooner.

## Scope
In:  either drop the capture-time encode (the runner's stays), or hand the capture's encoded image to the runner for that turn's first message (a retry, the resume fallback and later turns still read files); `capture.timing` keeps its five fields (encodeMs = wherever the encode then happens, or 0 with a DECISIONS row).
Out: changing the image the model receives (SPEC §2.3); a smaller full-resolution PNG.

## Done when
- [ ] `npx vitest run test/unit/capture.test.ts test/unit/app.test.ts test/unit/runner.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: one capture → `encodeForModel` runs once before claude is spawned

## Tests
Command: `npx vitest run test/unit/capture.test.ts test/unit/app.test.ts test/unit/runner.test.ts`
- unit: a capture's first turn encodes the image once (fakes count resize/toPNG/toJPEG on the model path) — proves the duplicate is gone
- unit: the image sent is the same as today's (2576 long edge; JPEG 85 over 3 MB) — proves SPEC §2.3 holds
- unit: retry and the resume fallback still load every screenshot from disk — edge cases that must not use a stale in-memory image

## Spec refs
SPEC §2.1, §2.3; tasks 007, 088.

## Notes
Found while measuring 088 (DECISIONS 2026-10-23 088, third row).
