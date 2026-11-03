# PROJECT_STATE

## Now
On master (W). 0.2.9 released into ~/dev/snapsolve-local and installed on Eric's Mac (update 0.2.8 → 0.2.9 ok, restarted): 089 answer mode, 096 hold-to-talk, 097 Esc stop, 098 listen to the Mac (⌃⌥B), 099 queued questions.
- These came from worktree-answer-mode, merged --no-ff as 008a6e7 after Eric's hand checks and a green full npm test (1320, e2e included); the five tasks closed by hand in tasks.json (Eric, option A). Worktree and branch removed.
- CoreGraphics approved for the speech helper (ARCHITECTURE, DECISIONS). `.claude/worktrees/` is in .git/info/exclude.
- Queue: 032 blocked on Eric's macOS checklist; backlog 033, 067, 069, 074, 092–095, 100 (question sent while a capture saves, from the 099 review).

## Log
2026-10-22 · adhoc · dark-theme code blocks grey #202327 (Claude Code's code view) instead of github-dark's near-black; e2e pins it (bac44b8)
2026-10-22 · adhoc · released snapsolve 0.2.3 into ~/dev/snapsolve-local (grey code blocks); updated on Eric's Mac (cb11abd)
2026-10-22 · keel · queued · 077 tray Appearance menu, 078 conversation sidebar, 079 pill composer (Eric's choices, mockup approved) (-)
2026-10-23 · 077 · closed · tray Appearance submenu (Dark / Light / Match macOS radio items after Reset window position) applies the theme live via nativeTheme.themeSource and saves only theme into config.json atomically (saveTheme); follow-up 080 (backlog) (2a20b35)
2026-10-23 · 078 · closed · Chats sidebar: one chat on screen, the others listed newest first under Today / Yesterday / Previous 7 days / Older; overlay over a scrim below 600 px (starts closed), docked from 600 px (starts open); choosing a chat shows it and openThread (preload 16, thread:open) makes main continue it on the next capture; sidebar New chat = + (0e082df)
2026-10-23 · 079 · closed · pill composer: rounded 20 px bar with the mic at the left, the text, a round fg-colored send at the right (faded when empty), buttons bottom-aligned as it grows; listening bar the same pill; placeholder Ask anything / Ask a follow-up; follow-up 081 (backlog) (d650089)
2026-10-23 · adhoc · released snapsolve 0.2.4 into ~/dev/snapsolve-local (077 Appearance menu, 078 Chats sidebar, 079 pill composer); updated on Eric's Mac (e4e2b27)
2026-10-23 · keel · queued · 082 sidebar stays closed after the user closes it (Eric's report on 0.2.4) (-)
2026-10-23 · keel · queued · 083 crop-corners equals icon for the menu bar and title bar (Eric's choice) (-)
2026-10-23 · 082 · closed · a sidebar the user closed (Hide chats, scrim, or a chat / New chat in the narrow overlay) stays closed across resizes until Show chats; narrowing still closes the overlay without counting as a user close (12a19c8)
2026-10-23 · 083 · closed · tray icon (drawTrayIcon, 16/32 px template bitmap) and the title-bar mark are four crop corners framing a bold equals sign, replacing the ring and dot (470fb57)
2026-10-23 · adhoc · released snapsolve 0.2.5 into ~/dev/snapsolve-local (082 sidebar stays closed, 083 crop-corners icon); updated on Eric's Mac (000bfb2)
2026-10-23 · keel · queued · 084 chat column and composer widen with the window (Eric's report on 0.2.5; cause: 078's 560 px cap) (-)
2026-10-23 · 084 · closed · the chat column, empty state and composer have no max width and widen with the window beside the sidebar (078's 560 px cap removed) (4605d68)
2026-10-23 · adhoc · released snapsolve 0.2.6 into ~/dev/snapsolve-local (084 chat widens with the window); updated on Eric's Mac (2eea53d)
2026-10-23 · keel · queued · 085 answer footer shows only the model and the response time (Eric, 0.2.6) (-)
2026-10-23 · 085 · closed · the answer footer is the model and the newest answer's response time only (no TTFT, no usage); usage stays in the tray tooltip (6c1f64f)
2026-10-23 · adhoc · released snapsolve 0.2.7 into ~/dev/snapsolve-local (085 footer: model and response time); updated on Eric's Mac (6f91a80)
2026-10-23 · keel · dropped · 070 (fixed by 076) and 080 (theme-save ordering), Eric's call (-)
2026-10-23 · adhoc · macOS checklist updated for 0.2.7: rows 3, 10, 14, 19, 21 refreshed; 23–27 added (Appearance, Chats sidebar, sidebar stays closed, text bar, wide window) (1e64924)
2026-10-23 · keel · queued · 088 window shows at once on capture (p0), 086 per-answer footer with model name (p1), 087 icon 15% smaller (p2); 054 dropped (Eric) (-)
2026-10-23 · keel · queued · 089 (backlog) your own answer format and knowledge base: parked until Eric answers what material and what format (-)
2026-10-23 · keel · dropped · 042, 053, 056, 066, 068, 081 (Eric) (-)
2026-10-23 · keel · queued · 090 see-through window + tray Transparency (p1), 091 default window ~9 × 6 in centred (p2) (-)
2026-10-23 · 088 · closed · a capture shows the window as soon as the screen is grabbed (panel.open before currentThread/createThread), Thinking… in the chat it lands in, then PNG / model encode / save (Screenshot.encode(), screenshotOf); a failed save shows captureFailed in that chat; capture.timing log line (grabMs pngMs encodeMs saveMs shownMs); measured ~280 ms sooner on the Mac; checklist row 28; found 092, 093 (31aa1af)
2026-10-23 · 086 · closed · each finished answer has its own footer right under it, <model name> · <its time> s, the model being the one claude reported in that turn's init event (saved on the turn; claude-opus-5-5 → Opus 5.5, [1m] dropped; old turns use the thread's alias); none while thinking or streaming, none on errors; the chat-wide status line is gone; src/shared/models.ts (b580194)
2026-10-23 · 090 · paused · for /keel tidy: DECISIONS.md reached 101/100 rows, which fails npm test's caps check (harness.test); code, tests and the 0.8 ground fix are on keel/090 (c8aaba2) (-)
2026-10-23 · 090 · closed · the window is see-through for real (transparent: true, the ground painted once on html) and tray › Transparency › 0% (solid) … 90% applies live and saves transparency (default 20); hand check → 032 row 29; found 094 (a16902c)
2026-10-23 · 087 · closed · the crop-corners symbol drawn about 15% smaller: tray bitmap in a centred square of size − 2·round(0.075·size) (14/16, 28/32 px, same proportions), title-bar mark 12 × 12; checklist row 3 (26a493b)
2026-10-23 · 091 · closed · the default window is about 9 in × 6 in real size (CGDisplayScreenSize via osascript, 110 pt/in when unknown), centred in the work area, on first open and Reset; e2e sidebar tests narrow the window themselves; checklist row 16; found 095 (17f8751)
2026-10-23 · adhoc · released snapsolve 0.2.8 into ~/dev/snapsolve-local (090 see-through + Transparency menu, 087 icon ~15% smaller, 091 9 × 6 in centred default, 088 faster show, 086 per-answer footer); updated on Eric's Mac (f9efb11)
2026-11-02 · keel · queued · 096 voice hold-to-talk (p1) and 097 Esc stops an answer (p2), backlog after 089: Eric's request, to build in a new session on worktree-answer-mode (-)
2026-11-03 · keel · queued · 099 queue a question asked during an answer (voice and ⌃⌥B no longer say wait; queued questions show at once); hand checks of 089/096/097/098 pass (Eric) (-)
2026-11-03 · 089 · closed · answer mode: a Solve / Answer switch in the title bar; Answer drafts your own answer from your knowledge folder (merged from worktree-answer-mode, closed by hand) (008a6e7)
2026-11-03 · 096 · closed · voice hold-to-talk: hold ⌃⌥V or the mic to record, let go sends (merged from worktree-answer-mode, closed by hand) (008a6e7)
2026-11-03 · 097 · closed · Esc stops an answer being written (merged from worktree-answer-mode, closed by hand) (008a6e7)
2026-11-03 · 098 · closed · listen to the Mac: hold ⌃⌥B to transcribe what the Mac plays, let go sends (merged from worktree-answer-mode, closed by hand) (008a6e7)
2026-11-03 · 099 · closed · a question asked during an answer queues (typed, voice, listen); queued ones show at once, faded, Queued (merged from worktree-answer-mode, closed by hand) (008a6e7)
2026-11-03 · adhoc · merged worktree-answer-mode into master (--no-ff) after the full npm test passed (1320, e2e included); CoreGraphics approved for the speech helper; two stale e2e expectations updated for 089/098 (008a6e7)
2026-11-03 · adhoc · released snapsolve 0.2.9 into ~/dev/snapsolve-local (089 answer mode, 096 hold-to-talk, 097 Esc stop, 098 listen to the Mac, 099 queued questions); updated on Eric's Mac 0.2.8 → 0.2.9; answer-mode worktree and branch removed (0807312)
