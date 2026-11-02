# 096 · Voice hold-to-talk: hold ⌃⌥V or the mic button to record, release sends

## Objective
Eric (2026-11-02, chat, before his General Magic call): "one more change. the voice button should be held. not toggle. hold to record and release sends it. escape key shoulkd be use to cancle any prompt send jsut as in any chat bot" (the Esc half is task 097). Then: "log the tasks list. we will built in new session."

Today (task 063, `src/main/voice.ts`): the voice hotkey ⌃⌥V or a mic button (title bar, composer) starts the speech helper; the same key or button again stops it and sends the transcript as a follow-up; Esc (a global shortcut held only while listening) or hiding the window cancels.

## Scope
In (proposed; confirm with Eric first, the brainstorm is still open):
- Hold ⌃⌥V: listening starts on press and stops and sends when the keys are released.
- Hold a mic button: pointer down starts, pointer up sends; the pointer leaving the button or the window losing focus while held still sends (or cancels: Eric's call).
- Esc while held still cancels without sending; an empty transcript still shows the empty note.
- A press too short to say anything (proposed under ~300 ms) cancels instead of sending an empty question.
- SPEC amendment (next free number), DECISIONS row quoting Eric.
Out: toggle mode as an option (unless Eric wants both); changing the speech helper's recognition.

## Done when
- [ ] Holding ⌃⌥V shows the listening bar with the live transcript; releasing sends it to the chat on screen (or a new chat) as a voice-marked question.
- [ ] Holding a mic button does the same; releasing sends.
- [ ] Esc while holding cancels; a very short press sends nothing.
- [ ] Unit suite green (`npx vitest run --project unit`), build ok, caps ok; e2e only when Eric says windows are OK; an Opus review passes.

## Tests
Command: `npx vitest run --project unit test/unit/voice.test.ts test/unit/app.test.ts test/unit/hotkeys.test.ts`
- key down starts the helper once (auto-repeat ignored); key up after "ready" sends SIGINT (stop and send); key up before "ready" waits for it, then sends.
- key up after a very short hold cancels (SIGTERM), nothing sent.
- Esc while held cancels; a later key up does nothing.
- release detection fails or never comes (a poll/monitor error): listening still ends (a cap or the existing stop path), logged.
- mic button: pointerdown → start, pointerup → stop and send; pointercancel / blur while held → the chosen behavior.
- preload: if a new IPC call is added, the exposed function count in SPEC §4.4 and its test change with it.

## Spec refs
SPEC Amendment 11 (voice), §4.4 Preload API, §7.1.

## Notes
- Hard part: Electron's `globalShortcut` fires on key press only; there is no key-up event. Release of ⌃⌥V needs detection, e.g. the Swift speech helper (native/speech/main.swift) polling `CGEventSourceFlagsState(.combinedSessionState)` for ⌃/⌥ still down and reporting a JSON line when they go up, or an `NSEvent` global monitor (likely needs Accessibility / Input Monitoring permission: check before choosing). Verify whatever is chosen on Eric's Mac.
- Build on branch `worktree-answer-mode` in `.claude/worktrees/answer-mode` (Eric runs that build with `SNAPSOLVE_DATA_DIR=~/snapsolve-answer-test npm start`), following keel by hand like 089 (tests commit, red on the unit suite, implement, review). No `npm test`, no e2e runs: windows pop up on Eric's screen.
- Open brainstorm question for Eric: on a call, what do his hands do to ask a question (keys or mic button), and does he ever want hands-free toggle back?
