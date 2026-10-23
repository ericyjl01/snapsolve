# PROJECT_STATE

## Now
Origin https://github.com/ericyjl01/snapsolve.git (default branch master). macOS only; `npm test` is green on the Mac.
- Installed on Eric's Mac: 0.2.7 (2026-10-23): 085 answer footer = model · response time only (Amendment 19);
  doctor all ok. (0.2.6: 084 chat widens with the window.) DESIGN.md footer lines noted on backlog 068.
- Queue: all blocked — 032.
- Blocked: 032 (Eric's macOS checklist). Backlog 033, 042, 053, 054, 056, 066–069, 074, 081 (070, 080 dropped
  by Eric). Open with Eric: which other backlog tasks to drop; what "icon looks right for 033" means.

## Log
2026-10-17 · 059 · closed · resize from any edge or corner (SPEC Amendment 7): resizable + 280 × 300 minimum only while open and at rest, moved/resized share the save path (per display, never from a transition), under-minimum sizes put back and not saved, saved sizes raised to the minimum then clamped, drawn grip; hand drag deferred to 032; found 067 (backlog e2e flake) (1bf32d2)
2026-10-17 · 060 · closed · show/hide hotkey Control+Alt+X (SPEC Amendment 8): hidden = win.hide(), starts hidden, tab and transitions removed, always resizable with the minimum; hotkeys.toggle validated (clash across all three → defaults), registered/paused/re-registered; tray Show/Hide snapsolve (⌃⌥X) via hotkeySymbols; installer default + SKILL.md; red re-run via revert (docs/issues.md); hand keypress → 032; found 068 (1ba1151)
2026-10-17 · 064 · closed · capture default Control+Alt+C (⌃⌥C) in config DEFAULTS, the installer's default config.json and DEFAULT_HOTKEY, SKILL.md (install, doctor, AltGr) and DESIGN D9; existing hotkeys.capture values kept, never migrated; reopened after Eric's OK for the one missing test (skill.test.ts asserts the doctor's 'On a Mac, say Ctrl+Option+C' line and that the section no longer names ⌃⌥Q); master merged into the parked branch keeping ⌃⌥C and 060's toggle ⌃⌥X together; found 069 (0f21ca5)
2026-10-18 · 061 · closed · native macOS restyle (mockup A2): vibrancy behind a transparent window on macOS, 36 px title bar with mark and × (preload hide on panel:hide replaces copy, SPEC Amendment 9), newest thread open with older threads as one-line rows, one composer pinned at the bottom for the newest thread, Retry only on error; Mac hand check → 032; follow-up 070 (f9e2c87)
2026-10-18 · 065 · paused · parked on keel/065 for the cloud session: code c0f97ed, unit/integration green, panel e2e 18/19 (the new + button test fails); next: fix it, SPEC Amendment 10 + DECISIONS rows, npm test, review, close (c0f97ed)
2026-10-18 · 065 · blocked · two macOS-only e2e assertions (content protection; userdata without the override) cannot pass in a Linux cloud session, so Done-when and close's full-suite gate cannot be met: platform-gate them (071) or close on the Mac? → keel/065 (caa71ef)
2026-10-18 · 071 · blocked · platform-gating the two macOS-only e2e assertions is 065's own block question (option a), so it waits for Eric rather than me answering it myself → not started (-)
2026-10-18 · 063 · blocked · needs a macOS toolchain (swiftc for the native/speech helper) and the Mac dictation check; not startable in a Linux cloud session → not started (-)
2026-10-19 · 071 · dropped · Eric chose option (b) — the two macOS-only e2e assertions stay as they are and 065 closes on the Mac, so there is nothing to platform-gate (-)
2026-10-20 · 065 · closed · on the Mac: a capture continues the current chat (newest thread on disk after a restart), + starts a new one (preload newThread on thread:new, SPEC Amendment 10, twelve functions), a typed question after + starts a text thread, hotkeys.append removed and warned, neutral append text; .thumb[hidden]; hand check → 032; found 072 (a3fb69b)
2026-10-20 · 072 · closed · docs/checklists/macos.md on master: 032's items with Ctrl+Option+C, follow-up and restart rows on the bottom composer, rows 16–21 for the deferred hand checks of 058, 059, 060, 061, 064, 065 (18ced94)
2026-10-20 · 073 · closed · ARCHITECTURE module map: app.ts's pipeline line names onCapture and newThread (onAppend was removed in 065); the edit rides the close commit (memory file) (3188a1a)
2026-10-20 · 063 · closed · voice follow-up: hotkeys.voice Control+Alt+V shows the window and runs the on-device speech helper (native/speech Swift, SpeechAnalyzer/SFSpeechRecognizer, built by npm run build, released as app/native); listening bar with live transcript; the key again sends via the follow-up path to the current thread (or a text thread) as a voice-marked turn; Esc/hide cancel, ignored while the thread answers, empty → note, denied → settings card, failure → error card; preload 15 (Amendment 11); hand check → 032 row 22 (315f4c6)
2026-10-21 · adhoc · released snapsolve 0.2.0 into ~/dev/snapsolve-local (redesign 058–061, ⌃⌥C 064, one chat + 065, voice 063 with app/native/snapsolve-speech); Eric: restart Claude Code, then /snapsolve update (b5a6c08)
2026-10-22 · adhoc · backlog 074: update must re-package snapsolve.app when Info.plist keys change (0.2.0 voice helper SIGABRTs without NSSpeechRecognitionUsageDescription) (-)
2026-10-22 · adhoc · queued 075: theme setting (dark default) and a more translucent window, Eric's choices (priority 0) (-)
2026-10-22 · 075 · closed · config.json theme dark|light|system (default dark) sets nativeTheme.themeSource before the window, so the panel and its blur are dark on a Light Mac; window ground more see-through (0.56 light, 0.50 dark); SPEC Amendment 12; e2e launches without Playwright's light emulation (8388539)
2026-10-22 · adhoc · released snapsolve 0.2.1 into ~/dev/snapsolve-local (075 theme, dark default, more translucent ground) (1ea96da)
2026-10-22 · adhoc · queued 076: dark code blocks, New York serif answers, terminal-style see-through (Eric's choices; priority 0) (-)
2026-10-22 · 076 · closed · dark code blocks (github-dark under prefers-color-scheme: dark), New York serif answers at 14 px with Menlo code, macOS window without vibrancy under an ~88% solid ground (Amendment 13) (604999c)
2026-10-22 · adhoc · released snapsolve 0.2.2 into ~/dev/snapsolve-local (076 dark code blocks, New York serif, no-blur ~88% ground); updated on Eric's Mac (d5bec90)
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
