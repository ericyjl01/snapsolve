# 065 · threads: capture continues the chat, + button starts a new one, no append key

## Objective
Eric (2026-10-17, DECISIONS conversation-model row): "It should always continue until I choose to open a new one or context is reached … Add a button on the top right with a plus, that would basically open a new chat." Today the capture hotkey always starts a new thread and a separate append hotkey (`hotkeys.append`, ⌃⌥⇧Q) adds a screenshot to the latest one (SPEC §2.1, §3.4 line 63).

## Scope
In:
- SPEC amendment: the capture hotkey (⌃⌥C, 064) appends to the **current thread** (the one shown at the top of the window) via the existing append path; with no current thread, or after "+", it starts a new thread.
- "+" icon button (aria-label "New chat") at the top right of the 36 px title bar (061), before ×. Clicking it marks "start fresh": the next capture, voice question (063) or typed question starts a new thread; the current card moves into the history list. Needs one preload call (e.g. `newThread`), recorded with a DECISIONS row and the preload-name list update.
- "Context is reached": keep the 6-screenshot rollover (`maxScreenshotsPerThread`, the 7th starts a new thread seeded with the last answer, card says so). Claude Code's own compaction covers long text conversations; no extra limit.
- Append-turn text becomes neutral, e.g. "Here is another screenshot. If it is unrelated to the earlier problem, treat it as a new question." (SPEC §3.1 stdin line; prompts/ if it lives there).
- Remove `hotkeys.append`: no default, not registered; an existing `hotkeys.append` in a user's config.json is ignored with one warning (not an error). Tray/SKILL/README wording updated.
- After a restart, the newest thread on disk is the current thread.
Out: per-thread switching from the history list (clicking an older row to make it current) — a follow-up if Eric wants it; voice (063).

## Done when
- [ ] `npx vitest run test/unit/capture.test.ts test/unit/app.test.ts test/unit/config.test.ts test/unit/hotkeys.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac: ⌃⌥C twice → both screenshots in one card, the second answer refers to the first; click + then ⌃⌥C → a new card; ⌃⌥⇧Q does nothing

## Tests
Command: `npx vitest run test/unit/capture.test.ts test/unit/app.test.ts test/unit/config.test.ts test/unit/hotkeys.test.ts test/e2e/panel.e2e.test.ts`
- "capture with a current thread appends" — proves the second capture resumes the same session with an image turn
- "capture with no thread starts one" — proves first-run behavior
- "new chat makes the next capture start a new thread" — proves the + flag, cleared after use
- "new chat then a typed question starts a new text thread" — proves + applies to typed questions too
- "7th screenshot still rolls over with the seed note" — proves the context limit is unchanged
- "append text is neutral" — proves the new stdin text
- "hotkeys.append is ignored with a warning and never registered" — proves removal and back-compat
- "current thread after restart is the newest on disk"
- e2e "+ button starts a fresh card" — proves the button and the preload call

## Spec refs
SPEC §1 hotkey line, §2.1, §3.1, §3.4, §4.4, §5 config; `src/main/capture.ts` decideAppend; `src/main/hotkeys.ts`; `src/main/config.ts`.

## Notes
Depends on 061 (title bar). Cost: every capture in a continuing chat resends the earlier screenshots, so it uses more of the plan than a fresh thread; "+" is the way to keep it cheap.
