# 088 · capture while hidden: the window shows at once, before the image is processed

## Objective
Eric (0.2.7): "when the app is not displayed and I capture the screen, It takes some time for the app to pop up. is there a fix for that?" Today a capture runs, in order, `desktopCapturer.getSources` at the display's full native size (3440 × 1440 on Eric's ultrawide), `toPNG()` and `encodeForModel()` (capture.ts `captureNow`), then `store.saveScreenshot` and only then `panel.open()` (app.ts `onCapture` / `newThread`). The window waits for all of it. First measure where the time goes, then show the window as soon as the screen has been grabbed, with "Thinking…" in the chat it will land in, and do the PNG, encoding and saving after.

## Scope
In:
- Measure: one `capture.timing` log line per capture with the ms spent in grab, PNG, encode, save and until the window is shown (log.ts, no answer text). Record the before/after numbers from Eric's Mac in docs/issues.md.
- The window is shown (`panel.open()`, `showInactive`, no focus taken) right after the grab returns, before `toPNG`, `encodeForModel` and `store.saveScreenshot`; the chat it lands in shows a pending state ("Thinking…") until the turn starts.
- If the grab fails or Screen Recording is denied, behaviour is as today (error or permission card); if saving fails after the window is shown, the chat shows today's capture error.
- If the measurement shows the renderer's first paint of a hidden window is the slow part, keep it painted while hidden (e.g. `backgroundThrottling: false` / `paintWhenInitiallyHidden`) — note which in DECISIONS.
Out: a smaller capture size (the model gets today's image); changing the hide-before-capture wait when the window is already open (150 ms).

## Done when
- [ ] `npx vitest run test/unit/capture.test.ts test/unit/app.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: with fakes that record call order, a capture while hidden calls `panel.open()` before `toPNG`, `encodeForModel` and `saveScreenshot`
- [ ] the `capture.timing` line appears in the log with all five fields

## Tests
Command: `npx vitest run test/unit/capture.test.ts test/unit/app.test.ts test/e2e/panel.e2e.test.ts`
- unit (app/capture): hidden window, capture → order is grab, panel.open, then PNG / encode / save (recorded by fakes); the thread id returned is the one shown
- unit: Screen Recording denied → no early open beyond today's permission card; grab throws → today's error, the window opens as it does today
- unit: save throws after the early open → the chat shows the capture error, nothing is left "Thinking…"
- unit: the `capture.timing` log entry has grabMs, pngMs, encodeMs, saveMs, shownMs (numbers ≥ 0)
- e2e: captureFromFile with the window hidden shows the window and the card's "Thinking…" (existing 009/059 checks still pass)
- edge: window already open → still hidden for the grab, then shown again; unchanged

## Spec refs
SPEC §1.1, §4.1; tasks 007, 009, 060.

## Notes
Eric 2026-10-23 (chat), quoted in Objective. Eric's display: 3440 × 1440 (system_profiler), so a full-size grab and PNG are large.
