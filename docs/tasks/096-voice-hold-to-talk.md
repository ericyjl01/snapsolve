# 096 · Voice hold-to-talk: hold ⌃⌥V or the mic button to record, release sends

## Objective
Eric (2026-11-02, chat, before his General Magic call): "one more change. the voice button should be held. not toggle. hold to record and release sends it. escape key shoulkd be use to cancle any prompt send jsut as in any chat bot" (the Esc half is task 097). Then: "log the tasks list. we will built in new session." In the new session, asked the open questions: "just go" (the calls below are Claude's; DECISIONS 2026-11-02 096).

Before (task 063, `src/main/voice.ts`): the voice hotkey ⌃⌥V or a mic button (title bar, composer) started the speech helper; the same key or button again stopped it and sent the transcript; Esc (a global shortcut held only while listening) or hiding the window cancelled.

## Scope
In (SPEC Amendment 27):
- Hold ⌃⌥V: listening starts on press; it stops and sends when ⌃ or ⌥ comes up (the speech helper watches the modifiers: `--hold control,option`, `{"type":"released"}`).
- Hold a mic button: pointer down starts; the pointer up anywhere in the window, a cancelled pointer, the window losing focus, or Space/Enter up sends (Claude's call: sends rather than cancels).
- Esc while held cancels; an empty transcript still shows "Didn't catch that.".
- A hold under 300 ms is a tap: cancelled, note "Hold to talk, let go to send.".
- A release that never arrives: stop and send at 120 s, logged `voice.holdCapped`.
- Preload `holdVoice(held)` (`voice:hold`) replaces `toggleVoice` (`voice:toggle`); still eighteen functions.
Out: toggle mode as an option (a voice key with no modifier keeps press-again, as nothing can be watched); changing the speech helper's recognition.

## Done when
- [x] Holding ⌃⌥V shows the listening bar with the live transcript; releasing sends it to the chat on screen (or a new chat) as a voice-marked question. (unit: voice.test; the real key-up on Eric's Mac is a hand check, below)
- [x] Holding a mic button does the same; releasing sends. (unit: voice.test, hold.test)
- [x] Esc while holding cancels; a very short press sends nothing. (unit: voice.test)
- [x] Unit suite green (`npx vitest run --project unit`: 1169 passed, 7 skipped after review 1), build ok (the helper compiles), caps ok; e2e updated but not run (windows pop up; Eric says when).
- [x] An Opus review passes (review 1 fail, two reasons fixed; review 2 pass).

## Tests
Command: `npx vitest run --project unit test/unit/voice.test.ts test/unit/hold.test.ts test/unit/ipc.test.ts test/unit/hotkeys.test.ts`
- voice.test (review 1): a key hold also holds Control+Alt+Escape, which cancels; both released after a cancel or a send; a button hold or a key with nothing to watch holds only Escape; a taken ⌃⌥Esc is logged and never unregistered; a press while finishing logs voice.pressIgnored; `holdEscape` maps the hold names to an accelerator.
- hold.test (review 1): a Space/Enter hold of the composer mic lets go on a key-up on body after the mic is hidden; a key-up does not end a pointer hold, nor a pointer-up a key hold.
- voice.test: a key press spawns the helper with `--hold control,option` (after its prefix args), a button press without; the released line → SIGINT and send once; repeats while held or finishing ignored; a button's dictation ends only on the button's release, the key's only on the released line; release before ready waits for ready; a tap (299 ms) → SIGTERM, hold note, nothing sent; 300 ms counts; Esc while held cancels and a later release does nothing; the 120 s cap stops and sends (logged) and does not fire after an end; no hold keys → press again to send; busy note on press, release after it does nothing; the earlier 063 cases (denied, failed, unavailable, crash, spawn error, stop timeout, no helper, Esc taken, send failure, transcript never logged, runs kept apart) through press/release.
- voice.test `holdModifiers`: Control+Alt+V → control, option; Cmd/CommandOrControl/Super/Meta → command; fixed order, no repeats; no modifier → [].
- hold.test (jsdom): pointerdown (main button) → held once, up anywhere → let go once; right/middle press nothing; pointercancel and blur while held let go; Space/Enter hold, repeats ignored; a second mic while held nothing; a click alone nothing.
- ipc.test: eighteen functions with `holdVoice` on `voice:hold`; `toggleVoice` / `voice:toggle` gone.
- e2e (not run): panel.e2e voice tests hold and let go (`snapsolveTest.voiceKey(down)`), the composer mic held with the mouse, a title-bar click is a tap with the hold note, the hint "let go to send · esc to cancel".

## Spec refs
SPEC Amendment 11 (voice), Amendment 27, §4.4 Preload API, §7.1.

## Notes
- Hand check on Eric's Mac (add to checklist 032 at merge): hold ⌃⌥V, speak, let go → sends; tap ⌃⌥V → the hold note; no Input Monitoring prompt appears; hold ⌃⌥V and press Esc → cancelled; hold the composer mic, drag off it, let go → sends; first use with the permission prompts (let go to click Allow: no question is sent; answering both prompts in over 15 s ends in "Voice input stopped working", and the next hold works); hold ⌃⌥V for a few seconds with the window hidden: one dictation, no restart (review 2 note: if macOS repeats a held global hotkey, a hold that ends while the keys are still down would start again); a quick tap may say "Didn't catch that." instead of the hold note when the helper starts slowly (its start-up counts as holding).
- Review 2 notes, not changed: a custom Command+Option voice key would hold ⌥⌘Esc (Force Quit) during a hold; the `voice:hold` boolean check (main.ts) and the renderer hint are covered only by e2e.
- Review 1 (fail): Esc while ⌃⌥ are held arrives as ⌃⌥Esc, which the bare Escape shortcut never catches → a key hold also registers `holdEscape(holdKeys)` (Control+Alt+Escape); a keyboard hold of the composer mic lost its key-up once the mic was hidden → hold.ts listens for the key-up on window. Tests 7f33687 (red: 12 failed), fixes c84e07c. Open for Eric: the helper now imports CoreGraphics (a system framework AVFoundation already loads), which ARCHITECTURE's approved speech line does not name.
- Built on branch `worktree-answer-mode` in `.claude/worktrees/answer-mode` by hand like 089 (tests 2204ac9, red: 51 failed; harness fix 9891ef3; code c29b118). No `npm test`, no e2e runs.
