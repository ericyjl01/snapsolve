# macOS checklist (M3)

Run by Eric on his Mac (DESIGN §8, SPEC §9.1). Fill in **Result** with `pass`, `fail: <what you saw>` or a note; every
`fail` becomes a follow-up task. The code behind each item is covered by tests (018, 028–031, 030's unit and e2e
tests, and the redesign 058–061, 064, 065); this list checks what only a real Mac, a real `claude` and a person can see.

Before you start: Claude Code installed and logged in (`claude auth status` → `"loggedIn": true`), Node ≥ 22.12, and
snapsolve **not** yet in System Settings › Privacy & Security › Screen Recording (remove it there to test the first
prompt).

| # | Item | How | Expected | Result |
|---|---|---|---|---|
| 1 | Install | In Claude Code: `/snapsolve install` | Ends with `ok:` lines; `~/Applications/snapsolve.app` exists; the app starts | |
| 2 | Screen Recording prompt on first capture → grant → Relaunch | Press Ctrl+Option+C with no grant yet | macOS shows its Screen Recording prompt; the panel shows "Grant Screen Recording in the prompt, then click Relaunch." with only **Relaunch**. Grant in the prompt, click Relaunch: the app restarts and the next Ctrl+Option+C captures | |
| 2b | Grant refused earlier | Turn snapsolve off in Screen Recording, press Ctrl+Option+C | The card says to grant it in System Settings, with **Open System Settings** (opens Privacy & Security › Screen Recording) and **Relaunch** | |
| 3 | Menu-bar icon, no Dock icon | Look at the menu bar and the Dock while snapsolve runs | Four crop corners around an "=" in the menu bar (tinted for light/dark), the same mark in the window's title bar (083); nothing in the Dock or the ⌘Tab switcher | |
| 4 | Ctrl+Option+C | Press it in Safari, Finder and a full-screen app | A card with the screenshot thumbnail and "Thinking…" within about half a second, then a streamed answer | |
| 5 | Capture of the cursor's display | With two displays, put the cursor on the second and press Ctrl+Option+C | The thumbnail shows the display under the cursor at its native resolution; the panel opens on that display | |
| 6 | Panel over a full-screen app and on other Spaces | Press Ctrl+Option+C in a full-screen app, then switch Spaces | The panel shows over the full-screen app and follows to the other Space | |
| 7 | Panel absent from the PNG (hide path) | With the panel open, press Ctrl+Option+C again; open the newest `<data>/threads/<id>/001.png` (tray › Open history folder) | The PNG shows the window behind the panel, not the panel and not a black box | |
| 8 | Panel in a Teams/Zoom share and a ⌘⇧5 capture | Share your screen in Teams or Zoom with the panel open; take a ⌘⇧5 screenshot | Record what you see. Expected on macOS: **visible** in ScreenCaptureKit apps (content protection does not hide it there) | |
| 9 | Follow-up | Type in the box at the bottom, press Enter | A second answer in the newest card | |
| 10 | Restart persistence | Tray › Quit, start snapsolve again (`/snapsolve start`), then type a follow-up in the box at the bottom | The newest chat is on screen and the older ones are in the Chats sidebar (078); the follow-up answers with that chat's earlier context | |
| 11 | `update` does not re-prompt for Screen Recording | `/snapsolve update` (with a newer version available), then press Ctrl+Option+C | No new Screen Recording prompt (only an Electron change re-packages the app and may re-prompt; the installer warns then) | |
| 12 | macOS 15 monthly re-authorization | Note over the following weeks | Record whether macOS shows a "continue to allow screen recording" prompt and when | |
| 13 | A timed-out turn leaves no `claude` process (018) | Set `"timeoutSec": 10` in `~/Library/Application Support/snapsolve/config.json`, restart, capture a hard problem; when the card says "Timed out", run `pgrep -fl claude` | No `claude -p` process left from snapsolve; Retry works | |
| 14 | Usage in the tray tooltip | Hover the menu-bar icon after an answer | "snapsolve · 5h N% · 7d M%". The line under an answer shows only the model and the time, e.g. "opus · 12.3 s" (085) | |
| 15 | Not logged in | `claude auth logout`, start snapsolve, then capture; log back in afterwards | A notification "Run `claude` once and log in." at startup; the card says the same | |
| 16 | Move the window (058) | Drag the window by its title bar to the middle of the screen, press Ctrl+Option+C twice; then tray › Reset window position | It opens at about 360 × 460 near the top-right; after the drag it stays where you left it; Reset puts it back near the top-right | |
| 17 | Resize (059) | Drag the left edge, then the bottom-right corner, to about 500 × 600; capture again; restart snapsolve | The size is kept after the capture and after the restart; it cannot go below 280 × 300 | |
| 18 | Show/hide (060) | Press Ctrl+Option+X, then again; look at the tray menu | The first press hides it with nothing left on screen; the second shows it where it was without taking focus from the app in front; the tray says Show/Hide snapsolve (⌃⌥X) | |
| 19 | Native look (061) | Compare with the A2 mockup in light and dark mode; click × in the title bar | A dark, slightly see-through background with no blur (076); serif answers with grey code blocks; a title bar with the Chats toggle, the mark, the chat's title, the mic, + and ×; no Copy button; Retry only on an error; readable in light and dark. × hides the window like Ctrl+Option+X | |
| 20 | Capture key (064) | Press Ctrl+Option+C; run `/snapsolve doctor` | Ctrl+Option+C captures; after its checks, doctor asks you to press Ctrl+Option+C | |
| 21 | One chat, + for a new one (065) | Press Ctrl+Option+C on a problem, then on its next part; click +, press Ctrl+Option+C; click +, type a question and press Enter | Both screenshots land in one card and the second answer refers to the first; after + the capture starts a new card; after + the typed question starts a new card with no thumbnail | |
| 22 | Voice (063) | After an answer, press Ctrl+Option+V, say "why the product rule?", press Ctrl+Option+V again; then press it, say something and press Esc; then press it and stay silent, press it again | The first time macOS asks for Microphone and Speech Recognition (grant both). The window shows without taking focus and the composer becomes a bar with a red dot, moving level bars and your words as you speak; the second press puts the question in the newest card with a small mic and it is answered. Esc sends nothing. Silence says "Didn't catch that." If voice says it isn't available or a prompt never appears, note it (the installed app may need re-installing for its new usage strings) | |
| 23 | Appearance (077) | Tray › Appearance › Light, then Dark, then Match macOS; restart snapsolve | Each switches the window at once, with no restart; the checked item is the one you picked, and it is kept after the restart | |
| 24 | Chats sidebar (078) | With a few chats, click Show chats (title bar, left); pick an older chat; then drag the window wider than about 600 px | Narrow: the list slides over the chat, newest first under Today / Yesterday; picking one shows it and the next capture continues it. Wide: the list is docked beside the chat | |
| 25 | Sidebar stays closed (082) | At a wide size, close the sidebar (Hide chats); resize the window narrower and wider again | It stays closed until you click Show chats | |
| 26 | Text bar (079) | Look at the box at the bottom with no chat on screen and with one; type and send | A rounded pill: mic on the left, round send button on the right; it says "Ask anything" with no chat and "Ask a follow-up" in one | |
| 27 | Text fills a wide window (084) | Drag the window to about 1100 px wide, with the sidebar open and closed | The answer and the text bar widen with the window; no fixed-width column | |

## Notes

- Data folder on macOS: `~/Library/Application Support/snapsolve` (config.json, logs/snapsolve.log, threads/).
- If something fails, the log line around the time of the failure (`logs/snapsolve.log`) is the most useful thing to paste back.
