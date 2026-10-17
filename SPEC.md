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
