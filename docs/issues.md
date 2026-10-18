# Issues (append-only; grep before debugging)

Entry format:

```
## YYYY-MM-DD · task <id> · <symptom in five words>
tags: <tag>, <tag>
Symptom: <what was observed>
Cause:   <root cause>
Fix:     <what fixed it> (<sha>)
Tried:   <dead end> — <why it failed>
```

## 2026-10-13 · task 001 · spawn EPERM launching electron.exe
tags: electron, windows, defender
Symptom: first `spawn(electron.exe)` from the smoke test failed with `Error: spawn EPERM` (errno -4048); running the exe from bash and every spawn variant in isolation worked.
Cause:   most likely Defender scanning the freshly downloaded, unsigned `electron.exe` on first launch (inferred, not proven).
Fix:     none needed; re-run passed and has passed every run since (ff5149e).
Tried:   spawn with/without windowsHide, env copy, cwd — all fine in isolation, so not an option bug.

## 2026-10-13 · task 001 · npm holds back install scripts
tags: npm, electron, esbuild, install
Symptom: after `npm install`, `npm warn allow-scripts esbuild@0.28.2 (postinstall …)`; `node_modules/electron/dist` absent.
Cause:   npm 11.17 runs install scripts only for packages listed in `allowScripts`; electron 44 also downloads its binary lazily on first `require('electron')`, not at install.
Fix:     `npm approve-scripts electron esbuild` (pinned entries in package.json `allowScripts`); first `require('electron')` downloaded the binary (ff5149e). The M2 installer must trigger that download (or run packager, which fetches via @electron/get).

## 2026-10-13 · task 002 · live tests leaked into npm test
tags: vitest, test-harness, live
Symptom: review fail — the unit test checking `npm run test:live` spawned the real live suite, so `npm test` would call real claude once test/live had files.
Cause:   asserting a script works by running it unfiltered.
Fix:     run `npm run test:live -- test/live/__no_match__` and assert `passWithNoTests` (5ad1e53).
Tried:   —

## 2026-10-13 · task 002 · clean-tree check covered fixed paths only
tags: vitest, git, artifacts
Symptom: review fail — `git check-ignore` on four paths could not catch other untracked files a test leaves behind.
Cause:   checked known artifact names instead of the tree.
Fix:     root `globalSetup` test/git-clean-setup.ts snapshots `git status --porcelain -uall`; teardown throws on new entries; works across vitest projects (5ad1e53, a92cdf4). Note: any test that writes into the repo must clean up or the whole run fails.

## 2026-10-13 · task 003 · ASR rule blocks electron.exe
tags: electron, windows, defender, asr, e2e, environment
Symptom: `npm test` e2e fails "electron.launch: Process failed to launch!"; `spawnSync(electron.exe)` → EPERM -4048; even opening electron.exe for read → "Access denied". Unit project (105 tests) green. Git Bash `find`/`timeout`/`tar` exit 126.
Cause:   Defender ASR (IT-managed, event 1121) rule 01443614-cd74-433a-b99e-2ecdc07bfc25 "Block executable files from running unless they meet a prevalence, age, or trusted list criterion" on node_modules\electron\dist\electron.exe. It also caused task 001's one-off EPERM (blocked 21:58). Electron ran fine through 002's close (22:26); after the 22:35:50 Defender intel/config update every launch is blocked (7 events 22:41–22:49, from node, cmd, bash, PowerShell). Rule c0033c00-d16d-4114-a5a0-dc9b3a7d2ceb "Block use of copied or impersonated system tools" blocks Git Bash's find.exe/timeout.exe/tar.exe.
Fix:     none in the repo; needs an ASR exclusion for electron.exe (IT/admin) or the cloud verdict to change. Never work around it (copying/renaming the binary is evading a security control). Avoid find/timeout/tar in Git Bash on this machine.
Tried:   re-running (blocked every time since 22:41); PowerShell/cmd/node/bash launchers — all blocked.
Status:  2026-10-14 re-check (015 precondition): still EPERM. Eric: leave it, finish 015 on a Mac (DECISIONS 2026-10-14). Until then nothing that launches Electron (e2e, smoke, 009's panel) can be verified on this PC.
         2026-10-17: on Eric's Mac the precondition prints `ok` and `npm test` (incl. e2e) is green; 015 restores `npm test` as the gate. The Windows PC still needs the exclusion.

## 2026-10-14 · task 003 · config create not atomic, unasserted
tags: config, atomic-write, review, tests
Symptom: review fail (attempt 1) — config.json was created with a plain write (a crash or a racing second instance could leave a torn or half-written file), and several "invalid value" cases did not assert the file was left untouched (SPEC §6.1 "the file is not overwritten").
Cause:   treated creation as a one-off write instead of an atomic publish; asserted only the returned config, not the bytes on disk.
Fix:     write defaults to `<file>.<uuid>.tmp` (`wx`, fsync) then `link` it into place, EEXIST → read the winner's file; byte + mtime snapshots on every warning case, plus no-temp-left, read-not-rewrite and create-failure tests (7c2ad75, 7ac498b).
Tried:   —

## 2026-10-14 · task 005 · Git Bash sort also blocked
tags: windows, defender, asr, git-bash, environment
Symptom: `… | sort | uniq -c` → `/usr/bin/sort: Permission denied`.
Cause:   same ASR rule c0033c00 ("copied or impersonated system tools") as find/timeout/tar: Git Bash's sort.exe shares a name with C:\Windows\System32\sort.exe.
Fix:     do counting/sorting in Python. Blocked so far: find, timeout, tar, sort.
Tried:   —

## 2026-10-14 · task 006 · runner integration tests flaky under load
tags: windows, defender, rename, vitest, flaky
Symptom: ~1 in 15–50 runs of 5 parallel `vitest run test/integration/runner.integration.test.ts` failed: `ob` not ok (missing claudePath), no-conversation saw 1 fake start instead of 3, cap 2 saw 2 starts or an overlap count of 3.
Cause:   (1) `writeJsonAtomic` renames once; under load the rename onto thread.json transiently fails EPERM (outcome `cannot save thread … (EPERM)`) — no in-process overlap (writes per thread are serialized), so another process holds the file (Defender/indexer, inferred). Unchecked setup turns hid this as wrong start counts. (2) the cap test counted runs overlapping each run's lifetime, not processes alive at one instant.
Fix:     cap check measures peak concurrency (9770934); every turn's outcome is checked and prints kind+message (e762521); 016 retries transient rename errors (006 depends on it).
Tried:   suspecting fake output loss — 120 stressed runs lost none; `toMatchObject` on the outcome hid the message (use toEqual).
Note:    stress driver = N rounds × 5 parallel `node node_modules/vitest/vitest.mjs run <file>`; editing a tracked file mid-run fails every run via the git-clean teardown.

## 2026-10-14 · task 006 · review failed three times
tags: runner, review, logging, transcripts
Symptom: attempts exhausted at review 2 (attempt 1 = the first build; reviews at d261bfc+fixes and b7280c2 failed).
Cause:   review 1 — `fail()` logged no details and the card showed raw internal text (fixed in f0fefa9, b7280c2). Review 2 — (1) a spawn error's `spawnargs` (full argv incl. `--system-prompt`) reaches runner.turnFailed via the error's cause, because log.ts copies an error's own fields (verified: ENOENT error keys errno, code, syscall, path, spawnargs); (2) adoption runs only after a successful turn, so a crashed/timed-out first turn leaves `<sid>.jsonl` (base64 screenshot) in the projects dir, against SPEC §3.4 "after a thread's first turn exits".
Fix:     Eric approved the proposed fix (DECISIONS 2026-10-14): a spawn failure's cause is `{code, syscall, path, message}` only (`spawnFailure`); a first or fallback attempt where claude started (`pid` set) adopts its transcript before the outcome is recorded; tests with a Node-shaped error, the real spawn ENOENT, crash, hang and a crashing fallback (6f4ccd0, 9c772b5). Review 3 passed.
Tried:   logging `error: e` as-is to satisfy review 1 — it also logs `spawnargs` (the prompt).
Tried:   adopting only on success — leaves transcripts outside the data dir after failed first turns.

## 2026-10-14 · task 007 · capture tests missed ordering bugs
tags: capture, tests, review, async
Symptom: review fail — all 28 tests passed with a missing `await` on the 150 ms hide wait, with the panel re-shown before the capture settled, and with the raw full-size PNG sent instead of the encoded image.
Cause:   the wait/getSources fakes recorded only their start and resolved at once, so call order looked right without each step waiting; the send test used a 1918×1199 image the encoder leaves unchanged.
Fix:     fakes settle on a later timer turn and record their finish ("waited", "got sources", "getSources failed"); a 3840×2160 capture asserts full-size png vs 2576×1449 send (7d9c9af).
Tried:   order-only event lists — prove the sequence of calls, not that each step finished before the next.

## 2026-10-14 · task 008 · npm override kept nested katex
tags: npm, overrides, katex, dependencies
Symptom: after adding `"overrides": {"@vscode/markdown-it-katex": {"katex": "$katex"}}` and `npm install`, `npm ls katex` still showed the plugin's nested katex@0.16.47 as `invalid` (ELSPROBLEMS) and `npm audit` still flagged GHSA-238p-pmpm-9mq7.
Cause:   npm keeps an existing lockfile entry; the override applies only when the dependency is resolved again.
Fix:     `npm uninstall @vscode/markdown-it-katex` then `npm install @vscode/markdown-it-katex@^1.1.2` → one katex@0.19.0 (deduped), audit 0 (d23d031).
Tried:   plain `npm install` after adding the override — leaves the nested copy in place.

## 2026-10-14 · task 012 · system prompt needed two changes; sonnet's answer line
tags: prompt, live, claude, sonnet, tests
Symptom: (1) the DESIGN §3.4 draft's example was the algebra fixture's own equation; (2) opus once answered code-bug ("the loop starts at index 1") without quoting the faulty line, failing the first-line check; (3) sonnet/high wrote wrong answer lines (36/5 h, then 21/5) and corrected them in the body; (4) the algebra pattern rejected a correct `x = \dfrac{21}{3} = 7`.
Cause:   (1) planning example reused as the fixture; (2) the prompt never asked code answers to point at the line; (3) sonnet commits to the answer line before working the problem (TTFT ≈ 2.7 s, little thinking); (4) pattern too literal.
Fix:     new example `2(x + 3) = 5x − 6`; bullet "a bug in code: the answer line quotes the faulty line and states the fix"; opus stays the default (DESIGN §10 item 5); pattern accepts a chain ending in 7 (01f3e3d, 4851ece). Final prompt: opus 4/4 in five consecutive runs (two mine, two by the reviewer, one in the close gate).
Note:    code-bug answers run 19–24 lines against the < 25 limit, so a longer opus answer would fail the live test; the algebra pattern also accepts contrived wrong lines ("x = 3, so 2x + 1 = 7", "x = 7/3") — both from the 012 review.
Tried:   the draft verbatim — the algebra test then proved nothing.

## 2026-10-14 · task 021 · review failed: wrong hint, weak test
tags: bootstrap, review, tests, electron
Symptom: first review failed: (1) the error box for a `main.js` that throws while loading said "Run /snapsolve doctor" although Scope said every failure names `/snapsolve install`; (2) the "no side effects outside Electron" test still passed with a top-level `require("electron")` added to boot.js.
Cause:   (1) doctor only diagnoses (auth, version, ASR, hotkey) and repairs nothing; (2) the test spied on `process.exit`, but boot exits through `app.exit`, and in plain Node `require("electron")` just returns the binary's path, so nothing observable happened.
Fix:     message names `/snapsolve install`; the test asserts no `node_modules/electron/` module is in `require.cache` after loading boot.js (mutation-checked) (fb8e27a).
Tried:   spying on `process.exit` alone — blind to Electron access.

## 2026-10-14 · task 022 · close refused: ARCHITECTURE.md is memory
tags: keel, close, memory, architecture
Symptom: `tasks.py close 022` → "memory committed on keel/022: ARCHITECTURE.md"; the run halted (repo-level failure per CLAUDE.md).
Cause:   the module-map extension was committed on the task branch (362f686); tasks.py treats ARCHITECTURE.md like DECISIONS.md — memory that only lands in the `<id>: close` commit on W. (DESIGN.md is not memory: 019 committed it on its branch without complaint.)
Fix:     Eric approved: ARCHITECTURE.md restored to master's version on keel/022 (2ce8b77); the module-map edit landed on master with `022: blocked` (425150a); the close gate then passed.
Note:    edit ARCHITECTURE.md in the working tree during a task and leave it uncommitted until the close commit.

## 2026-10-14 · task 022 · review failed three times
tags: release, review, node, packager, windows, rename
Symptom: review 1 (362f686): the staging-dir rename flaked EPERM (3 of 8 runs); a failed swap deleted the previous release; two loose assertions. Review 2 (cd746fd): pass. Review 3 (2ce8b77, after the ARCHITECTURE.md restore): (1) `@electron/packager` 20.3.0 and its `@electron/*` deps declare `node >=22.12.0` while DESIGN §4.2 preflight and the README row say Node ≥ 20; (2) the "no node_modules" rule is untested (the fixture's node_modules sits at the repo root, which assemble never reads).
Cause:   (1) the packager pin was chosen without checking `engines` (`npm view @electron/packager@20.3.0 engines` → >=22.12.0; 18.4.4 → >=16.13.0); (2) fixture placed the junk where the walk never looks.
Fix:     Eric chose to raise the Node minimum to 22.12 and keep packager 20.3.0 (DECISIONS 2026-10-14): DESIGN §4.2 and the README row say Node ≥ 22.12 (c117a61); the fixture plants node_modules in `bootstrap/` and the plugin `scripts/`, so dropping the exclusion fails 4 tests (fe6134a). Review 4 passed; closed at 2900b33.
Note:    check `npm view <pkg>@<version> engines` before pinning a runtime dependency the installer runs on the user's Node.
Tried:   single `renameSync` for the swap — EPERM under Defender, fixed by `renameRetrying` (cd746fd).
Tried:   `finally` cleanup deleting the moved-aside release — lost the old release on a failed swap; now restored (cd746fd).
Tried:   @electron/packager 20.3.0 with a Node ≥ 20 promise — engines mismatch (review 3).

## 2026-10-14 · task 028 · login-shell timeout could not stop the shell
tags: macos, shell, execFileSync, timeout, review
Symptom: first review failed: `execFileSync(shell, ["-ilc", …], { timeout: 3000 })` would not bound startup — the reviewer showed in WSL that `bash -ilc 'sleep 6'` sent SIGTERM at 1 s runs to 7 s and exits 0; also the `shell` option was untested and the "warning names the shell" assertion passed on the fake error text alone.
Cause:   an interactive shell ignores SIGTERM, Node's default `killSignal`, and execFileSync does not return until the child exits.
Fix:     `killSignal: "SIGKILL"` (asserted), a shell-option test, fake errors without the shell path (933027e).
Tried:   timeout alone with the default signal — unbounded on a hung rc file.

## 2026-10-14 · task 029 · harness broke exact-order tests; swallowed error
tags: capture, macos, tests, review, errors
Symptom: after red, three pre-029 darwin tests failed (their exact `events` lists gained "status screen"); the first review then failed on an empty `catch {}` around the prompting `getSources` and a stale `capture()` doc comment.
Cause:   the harness logged the new status check into the shared `events` list the panel-order tests compare exactly; the catch dropped the error although ARCHITECTURE says log it.
Fix:     status checks recorded in a separate `statusChecks` list (89fdcb8); `ScreenRecordingDeniedError(true, { cause })` with a "prompting call failed" message, asserted (22753f6).
Tried:   recording status checks in `events` — breaks the "existing tests unmodified" rule.
Note:    the mutex test first flipped the status synchronously, before the queued capture read it (fixed pre-red, 3016fa0); a 0×0-thumbnail getSources raising the prompt is unverified — 032 checks it on a Mac.

## 2026-10-14 · task 025 · SKILL.md frontmatter was invalid YAML
tags: skill, yaml, frontmatter, disable-model-invocation, review
Symptom: the first 025 reviewer found `description: … side panel). Subcommands: install, …` (since 022's placeholder) fails YAML (`mapping values are not allowed here`, PyYAML); Claude Code then drops every frontmatter field, so `disable-model-invocation: true` would silently stop applying and Claude could run `/snapsolve uninstall` on its own. The test passed: its `frontmatter()` helper split lines at the first colon.
Cause:   a plain YAML scalar cannot contain ": " (or " #", or start with an indicator character).
Fix:     description reworded to "Subcommands are …" (90739cc); tests check every frontmatter line against the plain-scalar rules and prove the check rejects known-bad values (013674b). Verified with PyYAML: `disable-model-invocation` parses as boolean true.
Note:    check SKILL.md frontmatter with a real YAML parser (`python3 -c "import yaml; …"`); `claude plugin validate` does not catch it.

## 2026-10-14 · task 025 · a reviewer started a headless Claude Code session that committed
tags: review, subagent, claude, headless, keel
Symptom: no verdict from the first 025 reviewer; it ran `BUN_BE_BUN=1 claude <script> <file>` hoping to use the binary's YAML parser, which instead started a real `claude` session with those paths as the prompt; that session committed 90739cc on keel/025 and rewrote `## Now` in PROJECT_STATE.md (plan usage spent).
Cause:   the `claude` binary does not honor `BUN_BE_BUN`; any `claude <args>` without `-p`/subcommand is a prompt.
Fix:     inspected the commit (2 files, correct fix, nothing else touched: reflog, branches, stash clean), kept it as the task's fix, tightened its test, rewrote Now, re-dispatched a fresh reviewer.
Note:    reviewers and agents must never run `claude` itself; use python3/node to parse files.

## 2026-10-14 · task 025 · review 2 failed: substring assertions
tags: skill, tests, review, substring
Symptom: `toContain(command("uninstall"))` was satisfied by the `uninstall --purge` line, and `toContain("install")` by "uninstall"; a SKILL.md that always purged history passed 17/17. DESIGN also stated bare `/snapsolve` works before 026 checked it.
Cause:   prefix/substring matching where a whole line or word was meant.
Fix:     commands matched as whole lines, each exactly once; `--purge` exactly once; subcommands as `\b` words; DESIGN says unverified until 026 (f58313d, edee170). Both reviewer mutations now fail tests.
Tried:   `toContain` on command text — blind to a longer command sharing the prefix.

## 2026-10-15 · task 034 · review 1 committed in the repo: scratch commands chained with `;`
tags: review, subagent, scratch, git, keel
Symptom: no verdict from the first 034 reviewer; its scratch setup (`git archive | tar` into the scratchpad, then `git init; git add -A; git commit`) ran in the repo after `tar` failed ("Permission denied"), re-initialising .git, adding `node_modules` to .git/info/exclude and committing 7eb92c5 "base" (author `r <r@x>`) with the uncommitted memory files on keel/034.
Cause:   commands chained with `;` after a failing step that should have changed the directory, so the git commands ran in the cwd (the repo).
Fix:     Eric approved `git reset --mixed 9473103` on keel/034 (local, never pushed; contents kept); fresh reviewer passed; DECISIONS 2026-10-15 (034).
Note:    scratch copies: chain with `&&` and use `git -C <scratch>`/absolute paths so a failed step cannot fall through to the repo. The extra `node_modules` line in .git/info/exclude is harmless (left as is).

## 2026-10-15 · task 044 · test file failed to parse after a Python-in-heredoc edit
tags: tests, heredoc, python, escaping, vitest
Symptom: `red` accepted, but only the steps file failed; installer-commands.test.ts reported "Transform failed ... Unterminated string" and ran no tests.
Cause:   test code inserted via `python3 - <<'EOF'` with a non-raw `"""..."""` string: `"\n"` in the TS became `"\n"` in Python, which wrote a real newline inside `r.lines.join("\n")`.
Fix:     restored the escape, committed `044: tests (fix …)`, re-ran `red` (40b9522).
Note:    when inserting TS through Python, use raw strings (`r"""…"""`) or the Edit tool; check every test file in the red output actually ran ("no tests" = parse error).

## 2026-10-15 · task 047 · "answer not in the error event" test failed after the fix
tags: tests, runner, error event, partial answer, log privacy
Symptom: `expect(JSON.stringify(events.at(-1))).not.toContain(ANSWER)` failed with the fix in place.
Cause:   the `error` event carries the whole thread, whose saved assistant turn keeps the streamed partial answer as its text (shown on the card by design).
Fix:     assert on the event's `message` (and the stored turn's `errorMessage`) instead of the whole event (0fcfd88).
Note:    privacy checks on runner events: target the error fields; the thread payload legitimately holds answer text.

## 2026-10-17 · task 009 · Playwright key presses skip before-input-event
tags: e2e, playwright, electron, keyboard, esc, panel
Symptom: panel e2e "Esc collapses to the tab" stayed at 420 px wide; main's `webContents.on("before-input-event")` never saw the key.
Cause:   Playwright's `page.keyboard.press` dispatches through CDP (`Input.dispatchKeyEvent`), which does not pass Electron's browser-side input pre-handler. Probe: listener saw `[]` after `keyboard.press("Escape")`, `["keyDown:Escape"]` after `webContents.sendInputEvent`.
Fix:     e2e sends keys that main handles with `webContents.sendInputEvent({ type: "keyDown"|"keyUp", keyCode })` from `app.evaluate` (d84a830). Use Playwright's keyboard only for keys the renderer handles (e.g. Enter in the follow-up box).

## 2026-10-17 · task 010 · review fail: tray "Open history folder" did nothing after Clear history
tags: review, tray, history, threads, openPath, clear history
Symptom: first reviewer failed 010: the tray's "Open history folder" called `shell.openPath(<data>/threads)` directly; after Clear history removes threads/, openPath returns an error string and nothing opens (silently).
Cause:   `shell.openPath` resolves with an error message instead of rejecting, and the folder is only recreated on the next capture.
Fix:     `openHistoryFolder` in tray.ts: mkdir -p threads/, then openPath, failures logged; unit test; Windows taken-key notice moved to `tray.displayBalloon` per the reviewer's note (f71b417).
Note:    `shell.openPath` never throws: check its resolved string, and create a folder the user may have cleared before opening it.

## 2026-10-17 · task 011 · review fail: uncommitted DECISIONS rows pushed the file over its cap
tags: keel, caps, decisions, review, harness, memory files
Symptom: reviewer 1 failed 011: `npm test` exit 1 at test/unit/harness.test.ts "keeps keel caps within limits" — DECISIONS.md 101/100 lines after five 011 rows (the committed tip itself was fine).
Cause:   the harness caps check reads the working tree, where memory files sit uncommitted until close; the rows were added after the last full-suite run.
Fix:     folded the two auth rows into one (100/100). `tasks.py review` refuses a pass on the commit that failed and memory files may not be committed on keel/<id>, so the tip moved with an empty marker commit (95753b5) naming the fix; reviewer 3 passed.
Note:    run `check.py caps` after adding DECISIONS rows and before the review; tidy DECISIONS.md when it nears 100 lines.

## 2026-10-17 · task 057 · panel e2e continued-note wait timed out (1 in 3 under load)
tags: e2e, flaky, panel, continued, seed, runner events, threads:changed, 051
Symptom: `test/e2e/panel.e2e.test.ts` 051 test timed out on its 10 s wait for the seeded card's `.note` (055 review: 1 of 3 full runs, 1 of 3 file runs); 6 of 6 isolated runs on an idle Mac passed.
Cause:   the note is derived from the thread's first user turn (`seed`), but the renderer never saw that turn until `answer:done`: `newThread` broadcasts the thread as created (no turns), the runner's `status` event only patches `status`, and `run()` appends the user turn without emitting anything. So the note waited for the whole answer; under load the answer took > 10 s. Contradicted DECISIONS 051 ("shows from the turn's start"). Same gap hid an appended thumbnail and a follow-up's question until the answer.
Cause 2: the test's first wait `${card(first)} .answer` also matches the streaming node (class `answer streaming`), so the append could run before the first answer was saved; the new thread then (correctly, DECISIONS 051) got no seed and no note. Dumps from failing runs: next thread.json had no seed, its claude started as a plain new thread. Proof: slow first answer + old wait → seeded=false every run.
Fix:     runner emits `{ type: "turn", threadId, thread }` right after saving the user turn; app remembers the thread and broadcasts threads:changed. The 051 and 057 e2e tests wait for `.answer:not(.streaming)` before appending. Deterministic e2e: seeded answer held ~20 s (slow scenario), note must show within 5 s with no finished answer.
Tried:   fix 1 alone still failed 1 of 9 file runs (cause 2); a 30-run loop also hit runs of 200–900 s that look like the Mac sleeping/throttling, not the app.
Note:    a card shows only what a runner event or listThreads delivered; anything saved to disk mid-turn needs its own event. In e2e, `.answer` includes the streaming node: wait for `.answer:not(.streaming)` when the saved answer matters.

## 2026-10-17 · task 064 · three review attempts used on test coverage + a SPEC.md commit
tags: keel, review, attempts, memory files, SPEC.md, skill test, hotkey, 064
Symptom: 064's code was right from the first commit (task tests + `npm test` green, grep clean), yet all 3 attempts went: review 1 fail, close refused, review 3 fail.
Cause:   (1) `commands.mjs` DEFAULT_HOTKEY had no test, because the installer-commands fake `writeClaudePath` writes the hotkey itself. (2) SPEC.md is a keel memory file; committing the Amendment on keel/064 made `close` refuse, and the restore commit made the passing review stale. (3) `skill.test.ts` checked the install text for Ctrl+Option+C but not the doctor's "On a Mac, say Ctrl+Option+C" line.
Tried:   review 1 fail → added the win32/darwin "config.json without hotkeys.capture" install test (b1130c4); review 2 pass.
Tried:   close → "memory committed on keel/064: SPEC.md" → `git restore --source=master --staged -- SPEC.md` + "064: restore memory" (3b6bb68) → review stale → review 3 fail (doctor Mac line unasserted).
Note:    SPEC.md amendments stay uncommitted until the close commit on W, like DECISIONS. Before the first review, mutate each changed literal back (scratch copy) and confirm some test fails, for user-facing text as well as code.
Fix:     Eric reopened it ("for 064 yes it is okay to reopen." (user, chat)): `unblock` reset attempts to 1, `start` merged master (058/059/060) into keel/064 — seven conflicts, all the same shape: keep 064's capture `Control+Alt+C` and 060's `toggle: "Control+Alt+X"` together (config.ts DEFAULTS, steps.mjs, SKILL.md install bullet + show/hide bullet, config/hotkeys/macos/skill tests; `macos.test.ts` 064's notification test also needed 060's `onToggle`). Then the two doctor assertions (0c821a6), review pass, closed (0f21ca5).
Note:    a long-parked task branch pays for it at `start`: resolve each conflict as "both changes", not one side, and re-run the task tests — the merge broke `config.test.ts:62` (a kept-value expectation that predates `toggle`).

## 2026-10-17 · task 059 · panel e2e "captureFromFile opens…" saw an answer before its no-answer check (1 in 4)
tags: e2e, flaky, panel, thinking, fake claude, slow scenario, cold start
Symptom: `test/e2e/panel.e2e.test.ts` first test: `expect(… .answer count).toBe(0)` got 1 (1974 ms, first test right after `npm run build`); 3 isolated reruns passed.
Cause:   (suspected) the slow fake emits its first text piece `FAKE_DELAY_MS / 3` = 500 ms after spawn; when the first window is slow to show "Thinking…", the answer node already exists by the time the check runs. Not from 059 (no renderer timing change).
Note:    backlog task (see tasks.py list): check the order (Thinking… before any .answer) from a renderer-side record, or raise the first piece's delay in that test.

## 2026-10-17 · task 060 · `tasks.py set --test-cmd` after red cleared red (code already in)
tags: keel, red, test_cmd, set, revert, process
Symptom: after adding a SKILL.md test and widening 060's test command, `tasks.py brief 060` showed `git show -`: no red commit; `red` runs at HEAD, where the code already passed.
Cause:   `set --test-cmd` invalidates red (and review) by design.
Fix:     reverted the implementation (e952ab9), ran red there (failing, recorded), reverted the revert (identical tree to 715a2a9). No history rewritten.
Note:    settle the test command before `red`; a test added later rides the existing command or goes in a file the command already runs.

## 2026-10-17 · task 064 · full suite flaked only under load: 058 drag e2e timed out at 120 s
tags: e2e, flaky, panel, drag, window.json, load, 058
Symptom: during 064's close prep `npm test` failed once — `panel.e2e.test.ts` "title bar drag moves the window … (058)" timed out in 120000 ms; that run took 158 s against 39–42 s for every other run.
Cause:   (suspected) machine load, not the app: the same file alone passed 10/10 in 15 s right after, and two later full runs were green (853 passed, 39 s). Editing PROJECT_STATE.md *during* a run also fails the suite's git-clean teardown ("the test suite left files git does not ignore") — unrelated to the tests.
Note:    backlog 069. Keep the working tree still while `npm test` runs, and re-run a timed-out e2e alone before treating it as a real failure.
