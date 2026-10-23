# 063 · voice follow-up: Ctrl+Option+V starts, Ctrl+Option+V again sends to the newest thread

## Objective
Eric (2026-10-17, mockup A2): press Ctrl+Option+V, speak a question, press Ctrl+Option+V again to stop and send it automatically as a follow-up to the newest thread (DECISIONS 2026-10-17 hotkeys; replaces the mockup's "any key sends"). Esc cancels.

## Scope
In (engine: macOS built-in, DECISIONS 2026-10-17 speech-to-text):
- A Swift helper (`native/speech/`, built with `swiftc` during packaging and in `npm run build` on macOS) that records from the default mic and transcribes on-device with `SpeechAnalyzer`/`SpeechTranscriber` (macOS 26), falling back to `SFSpeechRecognizer` with `requiresOnDeviceRecognition`; it streams partial and final text as JSON lines on stdout and stops on SIGINT/stdin close. Main spawns it per dictation (injectable spawn, like the runner).
- Info.plist: `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`; first use asks both; denied → permission card with Open System Settings.
- No audio file kept; the transcript is never logged (ARCHITECTURE Do NOT: no prompts in logs).
- `hotkeys.voice`, default `Control+Alt+V`, joining the hotkey lifecycle and config validation (distinct from capture/append/toggle).
- Pressing it: show the window (if hidden), start the helper, no keyboard focus taken (the global shortcut ends it), switch the composer into a listening bar (red dot, level bars, live partial transcript from the helper, "⌃⌥V to send · esc to cancel").
- Ctrl+Option+V again: stop, transcribe, send the text through the existing follow-up path to the newest thread (or start a text-only thread if there is none — decide in DECISIONS), shown with a mic mark.
- Esc: cancel, nothing sent (a temporary global Esc shortcut registered only while listening, unregistered after). Empty transcript: nothing sent, a short "Didn't catch that" note. Mic denied: a card with Open System Settings, like Screen Recording.
- The mic button in the title bar and composer does the same as the hotkey.
Out: wake words, continuous listening, spoken answers.

## Done when
- [ ] `npx vitest run test/unit/voice.test.ts test/unit/hotkeys.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: Ctrl+Option+V, say "why the product rule?", press Ctrl+Option+V again: the question appears in the newest thread and is answered; Esc instead sends nothing

## Tests
Command: `npx vitest run test/unit/voice.test.ts test/unit/hotkeys.test.ts test/e2e/panel.e2e.test.ts`
- "voice hotkey default and validation" — proves `Control+Alt+V`, clashes rejected
- "second Ctrl+Option+V sends" — proves the same hotkey toggles listening → send; a press while thinking/answering is ignored
- "Esc cancels" — proves no follow-up is sent and the temporary Esc shortcut is unregistered afterwards (also after send and on error)
- "empty transcript sends nothing and shows a note"
- "transcript goes to the newest thread via the follow-up path" — proves reuse of followUp, not a new channel
- "mic denied shows a permission card" — proves the denied path
- "helper output parsing" — proves partial/final JSON lines, malformed lines ignored, helper crash → error card, not a hang
- "helper is stopped on send, cancel and window hide" — proves no orphan process
- e2e with a fake helper: hotkey → listening bar → hotkey → user turn with mic mark → answer

## Spec refs
SPEC §4.2 (to amend), §5 config; `src/main/hotkeys.ts`; 062's DECISIONS row.

## Notes
Depends on 062 (closed: macOS built-in) and 058 (window). The real helper is checked by hand on the Mac (Done when); tests use a fake helper. Ctrl+Option+Space was avoided: macOS uses it to switch input sources.
