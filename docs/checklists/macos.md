# macOS checklist (M3)

Run by Eric on his Mac (DESIGN §8, SPEC §9.1). Fill in **Result** with `pass`, `fail: <what you saw>` or a note; every
`fail` becomes a follow-up task. The code behind each item is covered by tests (018, 028–031, 030's unit and e2e
tests); this list checks what only a real Mac, a real `claude` and a person can see.

Before you start: Claude Code installed and logged in (`claude auth status` → `"loggedIn": true`), Node ≥ 22.12, and
snapsolve **not** yet in System Settings › Privacy & Security › Screen Recording (remove it there to test the first
prompt).

| # | Item | How | Expected | Result |
|---|---|---|---|---|
| 1 | Install | In Claude Code: `/snapsolve install` | Ends with `ok:` lines; `~/Applications/snapsolve.app` exists; the app starts | |
| 2 | Screen Recording prompt on first capture → grant → Relaunch | Press Ctrl+Option+Q with no grant yet | macOS shows its Screen Recording prompt; the panel shows "Grant Screen Recording in the prompt, then click Relaunch." with only **Relaunch**. Grant in the prompt, click Relaunch: the app restarts and the next Ctrl+Option+Q captures | |
| 2b | Grant refused earlier | Turn snapsolve off in Screen Recording, press Ctrl+Option+Q | The card says to grant it in System Settings, with **Open System Settings** (opens Privacy & Security › Screen Recording) and **Relaunch** | |
| 3 | Menu-bar icon, no Dock icon | Look at the menu bar and the Dock while snapsolve runs | A ring-and-dot icon in the menu bar (tinted for light/dark); nothing in the Dock or the ⌘Tab switcher | |
| 4 | Ctrl+Option+Q | Press it in Safari, Finder and a full-screen app | A card with the screenshot thumbnail and "Thinking…" within about half a second, then a streamed answer | |
| 5 | Capture of the cursor's display | With two displays, put the cursor on the second and press Ctrl+Option+Q | The thumbnail shows the display under the cursor at its native resolution; the panel opens on that display | |
| 6 | Panel over a full-screen app and on other Spaces | Press Ctrl+Option+Q in a full-screen app, then switch Spaces | The panel shows over the full-screen app and follows to the other Space | |
| 7 | Panel absent from the PNG (hide path) | With the panel open, press Ctrl+Option+Q again; open the newest `<data>/threads/<id>/001.png` (tray › Open history folder) | The PNG shows the window behind the panel, not the panel and not a black box | |
| 8 | Panel in a Teams/Zoom share and a ⌘⇧5 capture | Share your screen in Teams or Zoom with the panel open; take a ⌘⇧5 screenshot | Record what you see. Expected on macOS: **visible** in ScreenCaptureKit apps (content protection does not hide it there) | |
| 9 | Follow-up | Type a follow-up in a card, press Enter | A second answer in the same card | |
| 10 | Restart persistence | Tray › Quit, start snapsolve again (`/snapsolve start`), then follow up on an old card | Old cards are listed with thumbnails; the follow-up answers with the earlier context | |
| 11 | `update` does not re-prompt for Screen Recording | `/snapsolve update` (with a newer version available), then press Ctrl+Option+Q | No new Screen Recording prompt (only an Electron change re-packages the app and may re-prompt; the installer warns then) | |
| 12 | macOS 15 monthly re-authorization | Note over the following weeks | Record whether macOS shows a "continue to allow screen recording" prompt and when | |
| 13 | A timed-out turn leaves no `claude` process (018) | Set `"timeoutSec": 10` in `~/Library/Application Support/snapsolve/config.json`, restart, capture a hard problem; when the card says "Timed out", run `pgrep -fl claude` | No `claude -p` process left from snapsolve; Retry works | |
| 14 | Usage in the tray tooltip | Hover the menu-bar icon after an answer | "snapsolve · 5h N% · 7d M%"; the same usage at the end of the card's status line | |
| 15 | Not logged in | `claude auth logout`, start snapsolve, then capture; log back in afterwards | A notification "Run `claude` once and log in." at startup; the card says the same | |

## Notes

- Data folder on macOS: `~/Library/Application Support/snapsolve` (config.json, logs/snapsolve.log, threads/).
- If something fails, the log line around the time of the failure (`logs/snapsolve.log`) is the most useful thing to paste back.
