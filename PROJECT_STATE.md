# PROJECT_STATE

## Now
Origin https://github.com/ericyjl01/snapsolve.git (default branch master). macOS only; `npm test` is green on the Mac.
- Installed on Eric's Mac: 0.2.7 (2026-10-23). Goal run in progress. Not yet released: 088, 086, 090, 087 (on master).
- Closed 090 (a16902c): see-through window for real (ground painted once, on html; review 1 caught html + body
  stacking) + tray › Transparency 0–90% live, saved; found 094 (tray click before the panel exists throws).
- Closed 087 (26a493b): crop-corners icon ~15% smaller (tray 14/16, 28/32 px; title-bar mark 12 × 12).
- Next: 091 (default window centred, ~9 in × 6 in; physical size via osascript JXA CGDisplayScreenSize,
  801.6 × 329.5 mm on Eric's LG, ~0.1 s; 110 pt/in fallback).
- Eric (chat): "release 0.2.8 when the queue is done" (DECISIONS row) → after `next` shows none
  left (032 blocked), release 0.2.8 into ~/dev/snapsolve-local and update his Mac, as 0.2.7.
- Blocked: 032 — Eric runs master's docs/checklists/macos.md (29 rows after 090).
- Backlog 033, 067, 069, 074, 089, 092, 093, 094. Dropped by Eric 2026-10-23: 042, 053, 054, 056, 066, 068, 070, 080, 081.

## Log
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
