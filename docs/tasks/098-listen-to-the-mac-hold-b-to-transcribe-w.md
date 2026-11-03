# 098 · Listen to the Mac: hold ⌃⌥B to transcribe what the Mac plays, let go sends

## Objective
Eric (2026-11-03, chat): "so control+ option + v lets me record voice. I have a app called Audio rec that records sound coming in to my mac and also sound that comes out of my mac. I want to make control+ option + b record the output. same feature that i have to hold it to record." Then, on the helper's new framework: "aprroved the built coreaudio framework", and set the goal run without answering what a release should do → Claude's calls below (DECISIONS 2026-11-03 098).

Before: ⌃⌥V (096) holds a dictation from the microphone; there was no way to turn what the Mac plays (a call, a video) into a question.

## Scope
In (SPEC Amendment 29):
- `hotkeys.listen` (default `Control+Alt+B`), registered, paused, resumed and reported taken like the other keys.
- Holding it: the same hold as ⌃⌥V (voice.ts source `listen`): the speech helper runs with `--source system --hold control,option`; the listening bar ("Listening to your Mac…" until words arrive); let go sends; a tap under 300 ms cancels with the hold note; Esc / ⌃⌥Esc cancel; the 120 s cap; the busy note; one dictation at a time (either source's press while the other runs is ignored).
- The helper's `--source system`: no Microphone request; a Core Audio process tap of everything the Mac plays (global stereo tap, unmuted, private) on a private aggregate device of the default output; the same on-device recognizer. Info.plist `NSAudioCaptureUsageDescription` (macOS's "System Audio Recording Only" prompt). The final line says `"silent":true` when every sample was zero (nothing played, or the permission was refused: macOS then gives silence, not an error).
- Sent where a typed question goes, marked `heard: true` (not `voice`): thread.json, retries and resume keep it; the card shows a speaker mark, title "Heard from your Mac". claude gets the text alone, as for voice.
- Empty transcript: "Didn't catch any words from your Mac."; silent: "Heard nothing from your Mac. If something was playing, turn on System Audio Recording for snapsolve in System Settings › Privacy & Security.".
Out: a button for it; recording to a file; mic and Mac audio together; picking one app to listen to; using the Audio rec app.

## Done when
- [x] Holding ⌃⌥B shows the listening bar with what the Mac is saying; letting go sends it as a heard question (unit: voice.test, app.test, runner.test; the real sound on Eric's Mac is a hand check, below).
- [x] ⌃⌥B is a registered hotkey with a config field, default and validation (unit: hotkeys.test, config.test).
- [x] The helper builds (`npm run build`) and, run by hand with `--source system` while `say` speaks, prints the spoken words (2026-11-03: "Walk me through your resume, starting with your most recent role." word for word; nothing playing → final `""` with `silent` at once; the mic path still records).
- [x] Unit suite green (`npx vitest run --project unit`: 1240 passed, 7 skipped), caps ok; e2e written for it, not run (Eric says when).
- [ ] An Opus review passes.

## Tests
Command: `npx vitest run --project unit test/unit/voice.test.ts test/unit/hotkeys.test.ts test/unit/config.test.ts test/unit/runner.test.ts test/unit/app.test.ts`
- voice.test: a listen press spawns `--source system --hold control,option` (after the prefix args), shows the window, holds Esc and ⌃⌥Esc; states carry `key: "⌃⌥B"` and `mac: true`; the released line sends via `send(text, true)`; a key press or button press while listening to the Mac is ignored, and a listen press while dictating; the key's or button's release does not end it; tap → hold note; Esc cancels; the 120 s cap; busy note; a listen key with no modifier is pressed again to send; empty final → the Mac's empty note, `silent` → the silent note; speechDenied → the card; unavailable → the note; the transcript never logged.
- voice.test parseHelperLine: `final` with `silent: true` keeps it; `silent` not true is dropped.
- hotkeys.test: four keys registered (listen → onListen), status has listen, a taken listen key notifies naming hotkeys.listen, pause/resume/re-register cover it.
- config.test: default `Control+Alt+B`; a good value kept; a bad one → default + one warning; listen equal to another key → all defaults.
- runner.test: a heard follow-up is saved as a text turn with `heard: true` and sent as plain text; a heard mark that is not true, or both marks, is refused without spawning; a retry keeps it.
- app.test: `onVoice(text, true)` enqueues `{ kind: "followUp", text, heard: true }` (in the chat on screen, or a new one); without it unchanged.
- e2e (not run): hold ⌃⌥B (`snapsolveTest.listenKey`), the bar says Listening to your Mac…, let go → `.question.heard` with a speaker mark, saved `heard: true`.

## Spec refs
SPEC Amendments 11, 27, 29; §1.1 hotkeys, §6.1 config.

## Notes
- Spike 2026-11-03 (scratchpad, not kept): a global process tap + aggregate device on Eric's Mac (macOS 26.6) got 48 kHz stereo float buffers with `say` audible (peak 0.19), no prompt shown to the terminal.
- Hand check on Eric's Mac (checklist 032 at merge): play a video with speech, hold ⌃⌥B, let go → the heard question with a speaker mark, answered; first use shows the System Audio Recording prompt; with it refused → the silent note; ⌃⌥V still dictates from the mic.
- Tests e97236d (red: 126 failed) and 9bd6c87 (installer bundle text and default, taken-key label; red: 3 failed); code 7a5f866. Found while building: with nothing playing macOS runs no audio callback, and SpeechAnalyzer then waits for ever after the end of input → a stop with no audio delivered ends at once (DECISIONS 2026-11-03 098).
- Fixed in passing: plugin SKILL.md still described voice as press-again (pre-096); now hold, plus the listen key.
