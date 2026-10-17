# 063 · voice follow-up: Ctrl+Option+V dictates, any key sends to the newest thread

## Objective
Eric (2026-10-17, mockup A2): press a hotkey, speak a question, press any other key to stop and send it automatically as a follow-up to the newest thread. Esc cancels.

## Scope
In (engine per 062's DECISIONS row):
- `hotkeys.voice`, default `Control+Alt+V`, joining the hotkey lifecycle and config validation (distinct from capture/append/toggle).
- Pressing it: show the window (if hidden), start recording (macOS microphone permission: `NSMicrophoneUsageDescription` in the launcher's Info.plist, `systemPreferences.askForMediaAccess("microphone")`), take keyboard focus so the next key reaches snapsolve (per 062), switch the composer into a listening bar (red dot, level bars, live transcript if the engine streams, "any key to send · esc to cancel").
- Any non-modifier key: stop, transcribe, send the text through the existing follow-up path to the newest thread (or start a text-only thread if there is none — decide in DECISIONS), shown with a mic mark; return focus to the previous app afterwards if possible.
- Esc: cancel, nothing sent. Empty transcript: nothing sent, a short "Didn't catch that" note. Mic denied: a card with Open System Settings, like Screen Recording.
- The mic button in the title bar and composer does the same as the hotkey.
Out: wake words, continuous listening, spoken answers.

## Done when
- [ ] `npx vitest run test/unit/voice.test.ts test/unit/hotkeys.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: Ctrl+Option+V, say "why the product rule?", press any letter: the question appears in the newest thread and is answered; Esc instead sends nothing

## Tests
Command: `npx vitest run test/unit/voice.test.ts test/unit/hotkeys.test.ts test/e2e/panel.e2e.test.ts`
- "voice hotkey default and validation" — proves `Control+Alt+V`, clashes rejected
- "any non-modifier key sends; modifiers and key repeat are ignored" — proves the end-of-dictation rule
- "Esc cancels" — proves no follow-up is sent
- "empty transcript sends nothing and shows a note"
- "transcript goes to the newest thread via the follow-up path" — proves reuse of followUp, not a new channel
- "mic denied shows a permission card" — proves the denied path
- e2e with a fake engine: hotkey → listening bar → key → user turn with mic mark → answer

## Spec refs
SPEC §4.2 (to amend), §5 config; `src/main/hotkeys.ts`; 062's DECISIONS row.

## Notes
Depends on 062 (engine) and 058 (window). Ctrl+Option+Space was avoided: macOS uses it to switch input sources.
