# PROJECT_STATE

## Now
On Eric's Mac at /Users/ericli/dev/snapsolve-master (no remote). macOS only (Amendment 4); local only (DECISIONS 055).
- 064 BLOCKED (attempts exhausted; work on keel/064, code green): review 3 wants 2 assertions on SKILL.md's doctor
  Mac line in test/unit/skill.test.ts:198-203. Asked Eric: OK to reopen 064 for that test-only fix? (docs/issues.md 064)
- 058 closed: floating 360 × 460 window, position per display in <data>/window.json, tray Reset window position.
  Its Mac drag/Reset check is manual → add to the 032 checklist rewrite.
- Queue (Eric: "begin working on these changes"): 059 → 060 → 061 → 065 → 063 in M3; backlog 066 (panelWidth).
- 032 waits until the redesign is done (Eric, chat): then rewrite docs/checklists/macos.md (keel/032) for ⌃⌥C/X/V, the floating window and no tab; release a bumped version; Eric runs `/snapsolve update` and the checklist.
- e2e on this Mac: keep it awake (`caffeinate -dims`); with the lid closed tests hang 150–900 s.
Backlog: 033 (macOS icon), 042, 053, 054, 056 (README row + plugin.json still say Windows).
Redesign canvas (mockup A2): https://claude.ai/artifact/YDwUWu2mMWHJui9b5unfPH. Open: is append (⌃⌥⇧Q) still wanted? (065 removes it)

## Log
2026-10-14 · 027 · closed · released plugin.json carries no version (claude-skills convention, Eric's answer); app/package.json keeps the app version for installer updates and the same-version refusal; DESIGN §5 updated; backlog 038 (4446bb5)
2026-10-14 · 031 · closed · macOS installer branch: ~/Applications/snapsolve.app (LSUIElement) packaged and ad-hoc signed once per packaging, open -a launch, pgrep -x quit, current symlink, uninstall removes the .app; Screen Recording re-prompt warning on an Electron change; SKILL.md brew/Screen Recording notes; follow-up 039 (52041e5)
2026-10-14 · 035 · closed · packageBootstrap returns warnings naming a previous launcher (Programs dir or .app) it could not remove, win32 and darwin, via an injectable rm; quitAndWait's default win32 isRunning tested (tasklist on the exe's basename, --quit only when listed, tasklist failure propagates); backlog 040 (5f8b828)
2026-10-14 · 036 · closed · a step failing after install/update quit the app restarts the previous version while current still resolves to it and its exe exists (warn: after the fail:); otherwise a fail: names the command to run; CLI hook wiring in realSteps.mjs, inert unless SNAPSOLVE_TEST=1; backlog 041 (0de5582)
2026-10-14 · 037 · closed · SKILL.md doctor names the data folder's files: hotkeys.capture in %LOCALAPPDATA%/snapsolve/config.json for the hotkey question, the log at %LOCALAPPDATA%/snapsolve/logs/snapsolve.log (both on Windows); test derives them from resolveDataDir + dataPaths (1743d47)
2026-10-14 · 039 · closed · doctor shows the Defender ASR text for a blocked smoke check only on Windows; on macOS the fail: names the EPERM and uninstall + install; SKILL.md doctor names the Mac config and log next to the Windows ones (6280d31)
2026-10-14 · 040 · closed · the three win32 quitAndWait default-isRunning tests use the shared advancing fake clock, so a processRunning regression fails in ms with the still-running error instead of an OOM worker crash (556ea59)
2026-10-15 · 041 · closed · a failed install/update whose previous exe is gone now says to run /snapsolve install (start only when the exe is there but fails to launch) (a91a53e)
2026-10-15 · 038 · closed · release.test.ts: the source plugin.json test is titled "names snapsolve and has no version" (assertions unchanged) (570c5ba)
2026-10-15 · 034 · closed · runner tests: a timed-out turn whose claude never closes settles at the SIGKILL (timeout + retry, queue moves on); a close after that settle emits nothing; found 042 (b7800f2)
2026-10-15 · 043 · closed · macOS config.json claudePath stores the resolved symlink (after realpath confirms it resolves) so Claude Code auto-updates do not break it; win32 keeps realpath; install passes platform (3f74473)
2026-10-15 · 044 · closed · one SemVer compareVersions exported from steps.mjs (pre-release below release, build metadata ignored, null when unparsable) used by preflight, doctor and update; doctor warns it cannot compare unparsable versions (15f92c0)
2026-10-15 · 045 · closed · steps.mjs exports renameRetrying, readJson, exists (follows links) and linkExists (dangling link counts); commands.mjs imports them and drops its copies; uninstall targets use linkExists (4baaef1)
2026-10-15 · 046 · closed · findTranscript stats project dirs concurrently (32 workers, StoreDeps.stat injectable); same newest-mtime result and warnings (eea7d86)
2026-10-15 · 047 · closed · a failed turn that streamed an answer logs errors/stderr plus 'result: <n> chars omitted' instead of the result text; classification unchanged (473afe1)
2026-10-17 · 048 · closed · macOS suite green: runner integration temp root realpath'd (macOS /var → /private/var), plus a symlinked-data-dir test; realSteps matches claude.exe by win32 basename so Windows paths match on any host (049 folded in) (9893090)
2026-10-17 · 015 · closed · npm test (unit + integration + e2e) is the full-suite gate again (keel.json, harness test); on Eric's Mac the Electron precondition is ok and the first full run of everything closed under the temporary gate is green (2218b7c)
2026-10-17 · 009 · blocked · SPEC §4.3 × / tab click vs §4.4 nine-function preload — Amendment 3 togglePanel()? → keel/009 (-)
2026-10-17 · 014 · closed · Electron userData is <data dir>/electron in every mode (resolveDataDir before ready); e2e covers the override and the platform default (HOME on macOS, LOCALAPPDATA on Windows); stale %APPDATA% cleanup left for the Windows PC (36c02ef)
2026-10-17 · 009 · closed · panel window per platform (content protection before first show, showInactive, 6-step 120 ms tab/open transitions, Esc in main), renderer served from snapsolve://app with thread thumbnails from snapsolve://thread, exactly the 9 preload functions, cards UI (Thinking…, streamed rendered answer, Copy, Retry, follow-up, status line), app.ts capture → store → runner → panel pipeline with event-ordered thread view, claude path resolution, captureFromFile test hook; follow-ups 050–052 (4ea2f32)
2026-10-17 · 010 · closed · hotkeys (capture/append, 400 ms debounce, taken-key notice naming hotkeys.<name>; Windows as a tray balloon), tray drawn in code with 5 items (Open panel, Pause/Resume, Open history folder creating threads/ first, Clear history, Quit), single instance with --quit, pause/resume on suspend/lock with hotkey re-registration; manual tray/capture checks deferred to 013/032 (f2a5903)
2026-10-17 · 011 · closed · auth.ts: claude auth status (output decides, identity fields never returned or logged), usage line 5h N% · 7d M%, block until resetsAt with a local reset time; runner rechecks auth after an error result, fails usage-blocked turns before spawning, saves warning/usage on answers; startup notice for not found / logged out; card warning + usage footer; tray tooltip usage (c0aa915)
2026-10-17 · 013 · blocked · needs a Windows PC that runs snapsolve (ASR-blocked work PC; work is on the Mac): park, split neutral checks to run here, or run capture checks on macOS? (-)
2026-10-17 · 030 · closed · macos.ts: darwinStartup hides the Dock before the tray and merges the login PATH once (warning logged), permission handlers (fixed Screen Recording settings URL, darwin only, args ignored; relaunch + exit), hotkeyLabel in the taken-hotkey notice; preload grows to eleven functions (Amendment 2); a denied capture shows an unsaved permission card in the panel; follow-up 053 (ce0a347)
2026-10-17 · 032 · blocked · needs Eric to run the macOS checklist and report results → keel/032 (a402d20)
2026-10-17 · 050 · closed · a Retry is a runner retry request: retryTarget re-runs the last user turn followed only by errored answers as the request that first ran it, without appending it again; resumes the owned transcript or takes the fresh-session fallback; nothing to retry → ok:false, no spawn (749b2df)
2026-10-17 · 051 · closed · an append past maxScreenshotsPerThread starts a thread seeded with the previous thread's last successful answer (seed on the first screenshot turn: image + seededQuestion, kept on retry, first of the earlier answers in a fallback); the card shows CONTINUED_NOTE; no answer → plain new thread (09c9d4f)
2026-10-17 · 052 · closed · recoverBusyThreads runs before the panel and hotkeys: threads an earlier run left new/queued/running become error with Retry (done when already answered), logged; unreadable threads untouched; follow-up 054 (backlog) (ad247a9)
2026-10-17 · 013 · dropped · Windows archived (Amendment 4): Mac only from now on (-)
2026-10-17 · 026 · dropped · Windows archived (Amendment 4); the first release moves to 055 on the Mac (-)
2026-10-17 · adhoc · macOS live run: opus/high 4/4 correct; rates once 60.3 s (claude 34.4 s), rerun 5.6 s (-)
2026-10-17 · 055 · closed · snapsolve 0.1.0 released into private marketplace ~/dev/snapsolve-local and installed in Claude Code as snapsolve@snapsolve-local (user scope); doctor ok for Node/claude/auth; skill is snapsolve:snapsolve; found 056 (backlog, widened to plugin.json) and 057 (flaky panel e2e) (3b5bed8)
2026-10-17 · 057 · closed · the continued note shows from the seeded turn's start: runner emits turn (the saved user turn) and app broadcasts it; the 051/057 e2e wait for the saved first answer, not the streaming .answer; 10/10 panel e2e runs (d1e5294)
2026-10-17 · adhoc · backlog 058 (drag to move the open panel) and 059 (resize it), Eric's asks after first use of 0.1.0 (-)
2026-10-17 · adhoc · backlog redesign from mockup A2: 058/059 rewritten as floating window + resize; 060 toggle hotkey, no tab; 061 native restyle, no Copy; 062 voice engine clarify (blocked); 063 voice follow-up (-)
2026-10-17 · adhoc · hotkeys decided (capture ⌃⌥C, toggle ⌃⌥Z, voice ⌃⌥V start+stop): 060/062/063 updated, 064 added; Eric's config.json capture set to Control+Alt+C (-)
2026-10-17 · adhoc · 065 added: capture continues the current chat, + button starts a new one, append hotkey removed (Eric's decision) (-)
2026-10-17 · 062 · closed · speech-to-text is macOS built-in (Apple Speech on-device via a Swift helper); Approved libraries updated; 063 scoped and queued in M3 (-)
2026-10-17 · 064 · blocked · review failed 3 times (last: doctor Mac line unasserted in skill.test.ts); reopen for a test-only fix? → keel/064 (3b6bb68)
2026-10-17 · 058 · closed · floating 360 × 460 window (SPEC Amendment 6): movable, 36 px drag-region title bar, opens at the cursor display's saved rect or 24 px from top-right, saved per display id in window.json after a drag rests (never from a transition), clamped into the work area on open/redock, hide keeps the position, tray Reset window position; Mac drag check deferred to 032; backlog 066 (panelWidth) (18f6a6e)
