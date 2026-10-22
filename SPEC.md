# snapsolve

Detailed design and rationale: `DESIGN.md` (v2, post-review). This spec is the testable contract; when they disagree, this file wins and DESIGN.md gets a note.

## Goals
- One hotkey captures the screen and returns a correct, concise, step-by-step explanation of the problem on it, in a side panel, in ~4 s.
- Runs on the user's own Claude Code login (`claude -p`); no API key.
- Windows and macOS; distributed as a Claude Code plugin in the `claude-skills` marketplace.
- Every capture, answer and transcript is kept locally, forever, outside synced folders.

## Behavior

### 1.1 Hotkeys
- Capture: `Control+Alt+Q` (macOS: Ctrl+Option+Q). Append screenshot to the current thread: `Control+Alt+Shift+Q`. Both configurable (§6.1).
- Capture hotkey debounced: presses within 400 ms of the previous accepted press are ignored.
- Registration failure → tray notification naming the key and the config field to change.
- "Pause hotkeys" (tray) unregisters both; "Resume" re-registers.
- On system resume, both are re-registered if `isRegistered` is false.

### 1.2 Lifecycle
- Single instance. Launching again opens the panel; launching with `--quit` makes the running instance quit.
- Manual start only (no login item).
- Tray (Windows notification area / macOS menu bar): Open panel · Pause/Resume hotkeys · Open history folder · Clear history · Quit. Tooltip shows usage (§3.6).

### 2.1 Capture
- Captures the display under the cursor at native resolution: requested size = display size × scale factor; actual size read from the image.
- Source selection: `display_id === String(display.id)`; else the source whose image size equals the requested size; else the first source.
- Captures are serialized; a press during a capture is queued, never dropped.
- The full-resolution PNG is saved to the thread before anything is sent.

### 2.2 Panel exclusion from capture
- Windows: the panel window has content protection, so it is captured directly without hiding (Windows 10 2004+; older builds use the hide path).
- macOS: if the panel is open, hide → wait 150 ms → capture → re-show. A collapsed tab is not hidden.

### 2.3 Image sent to the model
- Long edge > 2576 px → resized to 2576 (aspect kept). Encoded PNG > 3 MB → JPEG quality 85.
- At most 6 screenshots per thread. The 7th append starts a new thread seeded with the previous thread's last answer as text; the card says so.

### 3.1 Claude invocation
Every turn spawns `claudePath` with exactly:
`-p --safe-mode --strict-mcp-config --tools "" --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <model> --effort <effort> --system-prompt <contents of prompts/system.md>`
plus `--session-id <uuid>` on a thread's first turn, or `--resume <absolute transcript path>` on later turns.
- cwd `<data>/sessions` (created before every spawn); Windows `windowsHide: true`.
- stdin: one stream-json user message, then stdin closes. New thread: image block then text "Solve the problem on this screen." Follow-up: text. Append: image block then "Here is the next part."

### 3.2 Environment
- Removed from the child env: `CLAUDECODE*`, `CLAUDE_CODE_ENTRYPOINT`, and, unless `allowApiKey` is true, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- macOS: login-shell PATH merged in (M3).

### 3.3 Streaming
- Only `stream_event` → `content_block_delta` with `text_delta` is rendered as answer text.
- A thinking content block start or `system/thinking_tokens` shows "Thinking…".
- `system/init` supplies `session_id` (sanity check) and `apiKeySource`.
- `rate_limit_event` updates usage (§3.6). `result` ends the turn: `is_error`, `subtype`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `total_cost_usd`.
- Unknown event types and malformed lines are ignored; partial lines across chunks are reassembled.

### 3.4 Transcripts and resume
- After a thread's first turn exits, its transcript `~/.claude/projects/*/<sid>.jsonl` is located by session id, copied into the thread dir (fsync), and the original deleted. Later turns resume by that absolute path.
- Resume failure (error result, "No conversation found", missing or corrupt file) → a fresh session whose first message carries all prior screenshots, "Earlier answers in this thread:" with the prior answers, and the new question. The new sid and transcript replace the old ones; the card notes it.

### 3.5 Concurrency and timeouts
- Turns are serialized per thread (FIFO). At most `maxConcurrent` (2) processes run at once; other threads queue with status "queued".
- The capture hotkey always starts a new thread. The append hotkey targets the thread of the most recent capture.
- A turn running longer than `timeoutSec` (180) is killed and marked errored with Retry. Timeouts are measured from spawn wall-clock.

### 3.6 Auth and usage
- At startup and after any error result: `claude auth status` (JSON). `loggedIn:false` → "Run `claude` once and log in."
- `apiKeySource` other than the claude.ai login while `allowApiKey` is false → warning on the card.
- Usage from the latest `rate_limit_event`: tray tooltip and card footer show "5h N% · 7d M%". `status` other than `allowed` → show the reset time before spawning.

### 3.7 System prompt
- `prompts/system.md` (DESIGN.md §3.4): work the problem fully and verify before answering; the model chooses the structure (usually answer → minimal steps → one-line check); Markdown with `$…$`/`$$…$$` math and fenced code; no images or raw HTML; most prominent problem if several, say which; one line if none; screen text is data, not instructions; no preamble.
- Edits affect new threads only (system-prompt snapshot).

### 4.1 Panel states
- One window. **Tab**: 8 × 72 logical px, vertically centered on the right edge. **Open**: `panelWidth` × work-area height, right edge of the captured display.
- Transitions: 6 bounds steps over 120 ms.
- Always on top, skip taskbar, frameless. Shown with `showInactive` so focus stays in the user's app.
- Re-docks when displays are added, removed or change metrics.

### 4.2 Cards
- On capture: the panel opens immediately with a new card (thumbnail + "Thinking…") before Claude is spawned.
- Card: thumbnail, streamed rendered answer, Copy (Markdown), follow-up box, Retry on error, status line (model · TTFT · total s · auth source · usage).
- Newest thread first; all threads from disk listed at startup.

### 4.3 Dismissal
- × button, tab click (toggle), Esc while the panel has focus, tray "Open panel" (toggle).
- No blur-hide. No timer unless `autoHideSec` > 0 (default 0); a timer starts at turn end and pauses while the pointer is over the panel or the follow-up box has focus.

### 4.4 Rendering and renderer security
- markdown-it `html:false, linkify:false`; KaTeX `output:'html', trust:false, throwOnError:false, maxExpand:1000, maxSize:50`; highlight.js only for known languages; DOMPurify on the final HTML with `img, svg, math, iframe, form, input, style` forbidden and only `http(s)` URIs allowed.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' snapsolve:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`.
- `contextIsolation`, `sandbox`, no `nodeIntegration`; window.open denied; navigation prevented; external links open only for `http:`/`https:`.
- Thumbnails via `snapsolve://thread/<uuid>/<n>.png`, resolved only for existing threads with main-generated UUIDs.
- Preload API, exactly: `onDelta`, `onDone`, `onThreadsChanged`, `listThreads`, `followUp`, `retry`, `copy`, `openExternal`, `clearHistory`.

### 5.1 Storage
- Data dir: Windows `%LOCALAPPDATA%\snapsolve`; macOS `~/Library/Application Support/snapsolve`.
- `threads/<uuid>/thread.json`, `NNN.png` (001, 002, …), `<sessionId>.jsonl`; `sessions/`; `logs/snapsolve.log`; `config.json`.
- Thread list derived from `threads/*/thread.json`; unreadable threads are skipped and logged, never deleted.
- All JSON writes atomic (temp file + rename).
- Retention forever. Clear history (native confirm) deletes `threads/` then runs `claude purge "<data>/sessions" -y`.
- Logs never contain image bytes, base64 or answer text.

### 6.1 Config
- `config.json` in the data dir, created with defaults if missing: `hotkeys.capture`, `hotkeys.append`, `model` ("opus"), `effort` ("high"), `panelWidth` (420), `autoHideSec` (0), `claudePath` (null → PATH, then `~/.local/bin`), `allowApiKey` (false), `maxConcurrent` (2), `maxScreenshotsPerThread` (6), `timeoutSec` (180).
- Invalid or unknown values fall back to defaults with a logged warning; the file is not overwritten.

### 7.1 Error states (shown on the card)
| Condition | Message / action |
|---|---|
| `claude` not found (ENOENT) | "Claude Code not found. Run /snapsolve install." |
| Not logged in | "Run `claude` once and log in." |
| API key in use | Warning: billing to an API key |
| Usage limit | Reset time; Claude's message verbatim on error |
| Timeout | Killed; Retry |
| Resume failed | Automatic fallback (§3.4); note on card |
| macOS Screen Recording not granted | Grant / Open System Settings / Relaunch (M3) |
| Hotkey taken | Tray notification (§1.1) |

### 8.1 Distribution (M2)
- Plugin `snapsolve` in `claude-skills`: `.claude-plugin/plugin.json`, `skills/snapsolve/SKILL.md` (`install | start | update | doctor | uninstall`), `app/` (source + lockfile, no `node_modules`).
- Bootstrap app (`boot.js` → `<data>/app/current/main.js`) packaged once per Electron version; code updates swap `<data>/app/<version>` and the `current` link. Details: DESIGN.md §4.

### 9.1 macOS (M3)
- Screen Recording permission state machine, `type:'panel'` window, login-shell PATH, ad-hoc codesign once, LSUIElement. Details: DESIGN.md §3.2, §3.6, §4.

## Non-goals
- Region selection, multiple presets or user-edited output templates.
- Auto-start at login.
- Calling the Anthropic API directly or any non-Claude model.
- Signed/notarized distributables, auto-update, telemetry.
- Concealment beyond D18: no process disguise, no hiding from Task Manager or app switchers, no behavior aimed at proctoring or interview-monitoring software.

## Milestones

### M1 — Windows app, end to end (dev mode)
- `npm run build` + `npm start` launches the tray app on Windows.
- Ctrl+Alt+Q captures the cursor's display at native resolution, the panel opens immediately, and the answer streams in rendered (math, code), excluded from screen capture.
- Threads persist (screenshots, answers, owned transcripts); follow-ups and appended screenshots work, including after restart and after the original transcript is deleted.
- Error states, auth and usage surfacing per §3.6 and §7.1.
- Live tests: real `claude` solves the fixture problems correctly.
- Windows checklist automated where possible; the rest listed for Eric.

### M2 — Plugin and installer (Windows)
- `/snapsolve install|start|update|doctor|uninstall` on Windows from the `claude-skills` marketplace; bootstrap app; release script.

### M3 — macOS
- macOS code paths (§9.1) and the Mac checklist run by Eric on his Mac.

## Amendment 1 — 2026-10-14
§4.4, DOMPurify (Eric, task 017; DECISIONS 2026-10-14): KaTeX's inline SVG is kept. `svg` and `path` are allowed with only the attributes KaTeX writes — `xmlns`, `width`, `height`, `viewBox`, `preserveAspectRatio` on `svg` and `d` on `path`, plus `style`, which is allowed on every element. `img, math, iframe, form, input, style` stay forbidden, as does every other SVG element, so `\cancel`, `\bcancel` and `\xcancel` (drawn with `<line>`) show without their strike. Only `http(s)` URIs stay allowed. Reason: KaTeX draws the `\sqrt` radical, stretchy arrows, wide accents, braces and `\vec` as SVG; with `svg` forbidden, `$\sqrt{2}$` rendered as a bare 2. markdown-it has raw HTML off, so only KaTeX emits SVG.

## Amendment 2 — 2026-10-14
§4.4 Preload API and §7.1 (Eric, task 030; DECISIONS 2026-10-14): the preload exposes eleven functions, the nine of §4.4 plus `openScreenRecordingSettings()` and `relaunch()`. Neither takes an argument. `openScreenRecordingSettings()` makes main open the fixed URL `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`; main ignores it outside macOS. `relaunch()` makes main call `app.relaunch()` then `app.exit()`. `openExternal` still opens only `http:`/`https:` URLs. §7.1's Grant is the system prompt that the capture itself raises (DESIGN §3.2 step 5), so it needs no function. Reason: §7.1 puts Open System Settings and Relaunch on the macOS Screen Recording card, and the sandboxed renderer can do neither itself; with the URL fixed in main, the renderer still cannot open any non-http(s) URL.

## Amendment 3 — 2026-10-17
§4.3 Dismissal (Eric, task 009; DECISIONS 2026-10-17): the panel collapses to the tab only by Esc while the panel has focus (the user clicked into it), plus tray "Open panel" (toggle). There is no × button and the tab is not clickable; the next capture or tray "Open panel" reopens it. The preload API is unchanged (§4.4 and Amendment 2). Reason: × and tab click are renderer events that would need a new preload function; Esc is caught in main (`before-input-event`) with no IPC.

## Amendment 4 — 2026-10-17
Platforms (Eric, chat; DECISIONS 2026-10-17): snapsolve is **macOS only** from here on; Windows is archived, not deleted (`archive/windows/README.md`). Every Windows-only statement in this SPEC — §Goals "Windows and macOS", the Windows tray wording in §1.2, §2.2's Windows content protection, §3.1's `windowsHide`, §5.1's `%LOCALAPPDATA%` data dir, and the Windows wording of M1 and M2 — is inactive until Windows is brought back by a later amendment. M1 now reads "the app, end to end (dev mode) on macOS": the live tests and the end-to-end checks run on the Mac, and its checklist is `docs/checklists/macos.md` (task 032). M2 now reads "plugin and installer on macOS": the first release goes into the `claude-skills` marketplace on this Mac (task 055). The Windows code paths stay in the source, untouched and tested, so the archive can be resumed; new work does not extend them. Reason: the Windows work PC blocks snapsolve (Defender ASR) and all work now happens on the Mac.

## Amendment 5 — 2026-10-17
§Goals hotkey line, §6.1 config and the M1 capture check (Eric, chat; DECISIONS 2026-10-17 hotkeys row; task 064): the default capture hotkey is `Control+Alt+C` (macOS: Ctrl+Option+C), replacing `Control+Alt+Q` wherever this SPEC names it as the capture key. The append hotkey `Control+Alt+Shift+Q` is unchanged (task 065 removes it). A `hotkeys.capture` already written in a user's config.json is kept as written; only new installs and missing fields take the new default. Reason: Eric's choice ("screenshot should be ctrl+opt+c"); Ctrl+Option+C has no Apple default system shortcut.

## Amendment 6 — 2026-10-17
§4.1 Panel states, open state (Eric, chat: mockup A2 "Floating note window"; DECISIONS 2026-10-17 058; task 058): **Open** is a floating window the user drags by a 36 px title bar, default 360 × 460 logical px, first shown 24 px in from the right and top of the work area of the display under the cursor. After a drag it opens wherever the user left it on that display: the rect is saved per display id in `<data>/window.json` (not config.json), written after the drag rests, never by a transition step, and always clamped fully into the work area (resolution change, display removed). A display change keeps the window where it is if it still fits (no snapping to the edge). Tray "Reset window position" forgets the saved rects. `panelWidth` no longer sizes the window. The tab, the transitions and §4.3 are unchanged until tasks 059–061 and 065. Reason: Eric's choice of the A2 mockup after first use of 0.1.0.

## Amendment 7 — 2026-10-17
§4.1 Panel states, open state (Eric, chat: mockup A2; DECISIONS 2026-10-17 059; task 059): the floating window of Amendment 6 resizes from any edge or corner, not below 280 × 300 logical px, with a drawn (visual only) grip in the bottom-right corner. Its size is saved with its position per display in `<data>/window.json` and restored, at least 280 × 300 and clamped into the work area, on open, after a capture and on a display change; "Reset window position" also resets the size to 360 × 460. Only the open window is resizable; the tab is not. `panelWidth` stays a valid config.json key with no effect (task 066 decides its fate). Reason: Eric's choice of the A2 mockup.

## Amendment 8 — 2026-10-17
§4.1 Panel states, §4.3 Dismissal, §1.1/§6.1 hotkeys, Amendment 3 (Eric, chat; DECISIONS 2026-10-17 060; task 060): the window has two states, **shown** and **hidden**. Hidden is `win.hide()`: nothing on screen, no tab; there are no bounds transitions. A new hotkey `hotkeys.toggle` (default `Control+Alt+X`, macOS Ctrl+Option+X) shows a hidden window at its saved rect (Amendments 6–7) with `showInactive`, so focus stays in the user's app, and hides a shown one. It is validated, registered, paused and re-registered like capture and append; any two hotkeys set to the same key make all three fall back to their defaults with one warning. Esc (focused) hides; a capture, a second launch and the tray item show it. The tray's "Open panel" becomes "Show/Hide snapsolve (⌃⌥X)" (the configured key) and toggles. The window starts hidden. With `autoHideSec` > 0 the timer hides it. Reason: "There should be a hotkey to open it and close it, and when I close it, there should be nothing visible at all. Not even this little tab."

## Amendment 9 — 2026-10-18
§4.2 Cards, §4.3 Dismissal, §4.4 Preload API, Amendments 2, 3 and 8 (Eric, chat: mockup A2 "Native macOS", "Copy not needed"; DECISIONS 2026-10-18 061; task 061): the window takes the A2 look — macOS vibrancy behind a transparent window (an opaque window elsewhere), the system font, a 36 px title bar with the app mark, "snapsolve" and a × button that hides the window as Esc does (Amendment 8). The newest thread is a full card (thumbnail, title, time, the conversation with answers rendered as before, Retry only on an errored turn, status line); older threads are one-line rows (thumbnail, title, time) that open in place on click. One follow-up composer is pinned at the bottom of the window and sends to the newest thread (Enter sends, Shift+Enter is a new line). There is no Copy button: the preload's `copy(text)` and its `clipboard:copy` channel are removed and `hide()` (no argument; main hides the window) takes its place, on channel `panel:hide`, so the preload still exposes eleven functions: `onDelta`, `onDone`, `onThreadsChanged`, `listThreads`, `followUp`, `retry`, `hide`, `openExternal`, `clearHistory`, `openScreenRecordingSettings`, `relaunch`. Answer text is unchanged (the model's own Markdown through `render.ts`). Reason: Eric picked direction A2 and said Copy is not needed; the × needs one renderer → main call, which Amendment 3 had avoided.

## Amendment 10 — 2026-10-18
§Goals hotkey line, §2.1 Threads, §3.1 stdin, §3.4 Threading, §4.2 Cards, §4.4 Preload API, §6.1 config, Amendments 5, 8 and 9 (Eric, chat; DECISIONS 2026-10-18 065; task 065): one chat continues until the user starts a new one. The capture hotkey (`Control+Alt+C`, Amendment 5) **appends to the current thread** — the one at the top of the window, after a restart the newest on disk — through the existing append path; with no thread, after "+", or past `maxScreenshotsPerThread` it starts a new thread (the limit still seeds the new thread with the previous answer and the card still says so, §2.1). §3.4's "the capture hotkey always starts a new thread" no longer holds. The append text of §3.1 becomes neutral: "Here is another screenshot. If it is unrelated to the earlier problem, treat it as a new question."

The title bar of Amendment 9 gains a **"+" button** (aria-label "New chat") at its top right, before the ×. It marks "start fresh": the current card becomes a row and the next capture or typed question starts a new thread. The composer is therefore never disabled — with no current thread it reads "Ask a new question" and the text starts a new thread instead of a follow-up. This needs one more preload function, so §4.4 exposes **twelve**: the eleven of Amendment 9 plus `newThread(text?)` on channel `thread:new` (no text: the next capture or question starts a new thread; with text: a new text thread with it now).

`hotkeys.append` is removed: it has no default, is never registered, and one already in a user's config.json is ignored with a warning, not an error (Amendment 5's "unchanged" ends here, and Amendment 8's clash rule now covers two hotkeys, capture and toggle). Reason: "It should always continue until I choose to open a new one or context is reached … Add a button on the top right with a plus, that would basically open a new chat." A continuing chat resends the earlier screenshots, so "+" is also how the user keeps a question cheap.

## Amendment 11 — 2026-10-20
§Goals hotkey line, §1.1/§6.1 hotkeys, §4.2 composer, §4.4 Preload API, §7.1 permission cards, Amendments 8–10 (Eric, chat 2026-10-17: mockup A2 and the hotkeys row "Voice start should be ctrl+opt+v and voice end should also be ctrl+opt+v", "yes go with macOS built-in"; DECISIONS 2026-10-20 063; task 063): a question can be **dictated**. A third hotkey `hotkeys.voice` (default `Control+Alt+V`, macOS Ctrl+Option+V) is validated, registered, paused and re-registered like capture and toggle; Amendment 8's clash rule covers all three. Pressing it shows the window (`showInactive`, no focus) and starts on-device speech recognition (Apple Speech, a helper binary beside the app; nothing is recorded to disk and the transcript is never logged); the composer becomes a listening bar (red dot, input level, the live transcript, "⌃⌥V to send · esc to cancel"). Pressing it again stops and sends the final text where a typed question would go (Amendment 10: the current thread, else a new text thread), saved as a text turn marked as dictated and shown with a mic mark. A press is ignored while the final text is on its way, and a press that would start a dictation is ignored while the thread it would join is still thinking or answering ("Wait for the answer, then ask."). A helper that crashes or cannot run shows a panel-only error card. Esc (a global shortcut held only while listening) or hiding the window cancels, sending nothing; an empty transcript sends nothing and says "Didn't catch that." Mic buttons in the title bar and the composer do what the hotkey does. If macOS refuses Microphone or Speech Recognition, a panel-only card says which to turn on, with Open System Settings opening that pane (a fixed URL in main, as Amendment 2). §4.4 therefore exposes **fifteen** functions: the twelve of Amendment 10 plus `onVoice(listener)` (event `voice:state`), `toggleVoice()` (`voice:toggle`) and `openVoiceSettings()` (`settings:openVoice`); neither call takes an argument. Out: wake words, continuous listening, spoken answers. Reason: Eric's mockup A2 and hotkeys choice; voice is macOS only (Amendment 4).

## Amendment 12 — 2026-10-22
§4.2 look and §6.1 config, Amendment 9 (Eric, chat 2026-10-22: dark mode "Setting, default dark", translucency "A bit more"; DECISIONS 2026-10-22 075; task 075): config.json gains `theme`: `"dark"` (default), `"light"` or `"system"` (follow macOS); any other value falls back to `"dark"` with one warning, and a config.json without the key is read as `"dark"` and never rewritten. Main sets Electron's `nativeTheme.themeSource` from it before the window is created, so the panel's colors and the macOS blur behind it follow the setting rather than the system appearance; a change takes effect on restart. The window ground is more see-through: about 56% opaque in light (was 72%) and 50% in dark (was 66%); cards, rows and fields keep their opacity so answers stay readable. Out: a theme switch in the tray or window, a translucency setting. Reason: Eric keeps macOS in Light but wants snapsolve dark and a bit more glassy.

## Amendment 13 — 2026-10-22
§4.2 look, Amendments 9 and 12 (Eric, chat 2026-10-22: code blocks "should also be black, like the screenshot", font "Mac's serif lookalike", see-through "Like a terminal, no blur"; DECISIONS 2026-10-22 076; task 076): on macOS the window drops the OS blur (no `vibrancy`, no `visualEffectState`) and stays a transparent window (`backgroundColor` `#00000000`) under a near-solid ground, about 88% opaque: `rgba(24, 24, 24, 0.88)` dark and `rgba(246, 246, 248, 0.88)` light (supersedes Amendment 12's 50%/56% and Amendment 9's vibrancy). Code blocks use highlight.js `github-dark` (near-black block) in the dark theme and `github` in the light theme. Answer text and question bubbles are set in Apple's New York serif (`ui-serif`, `"New York"`, Georgia, serif) at 14 px; code and inline code in Menlo (`ui-monospace`, Menlo, monospace) at 12.5 px; the title bar, buttons and status lines stay the system sans. Off macOS unchanged. Out: Anthropic's own fonts, a code-block language label, a translucency setting. Reason: the dark panel was hard to read and looked solid; Eric wants it to read like the Claude app and be marginally see-through like a terminal.
