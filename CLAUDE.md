# snapsolve

## Working preferences

<!-- keel v5 -->
# keel — memory on disk
This repo keeps its memory on disk. Read ~150 lines, then build. Every task is test-first and independently reviewed.

## Session start
- The SessionStart hook injects a `[keel] state` block. If none is in context, run `python3 .claude/memory/tasks.py state`.
- "continue" / "go" / "next" / "what next" (or similar): give a 3-line brief (where we are / next task / blockers). If no `/goal` is active, print the goal line below for the user to paste and end the turn there: never start, resume or work a task before the goal is set, unless the user explicitly says to go ahead without it. During an active goal run, start the current task immediately, without waiting.
- When a turn begins because the user set the goal, your first output line is exactly `[keel] goal run started`.
- Any other request: do it on the work branch W (`work_branch` in tasks.json): commit `adhoc: <what>`, `tasks.py log adhoc "<what>"`, commit the memory files (`keel: memory`). If a task is in progress: finish the current step first (a running review, red or close is never interrupted; a request that can wait for the close is done right after it, and its memory may ride the next memory commit), otherwise `tasks.py pause <id>` first and, during a goal run, `tasks.py start <id>` after (outside one, leave it paused for the goal run; a tiny request in the task's own area may instead be done on `keel/<id>` as part of the task). A Log line only if it changed code; `tasks.py add` if it needs more than one commit.

## Pick
- Always the task `python3 .claude/memory/tasks.py next` names, never by preference; read only that task's file.
- "do 007 first": `tasks.py set 007 --priority 0` (plus `--milestone <current>` if 007 is backlog). With "now": also `tasks.py pause <current id>` first. Without "now": finish the current task first.
- `next: none — plan M<n>`: on W, read SPEC.md `### M<n>`; `tasks.py add "<title>" --milestone n --deps … --test-cmd "<command that runs only this task's tests>"` per outcome, foundation first; fill each task file (Objective, Scope, Done-when, **Tests** — each test and the behavior it proves, error and edge cases included; the tests are written as code only when the task starts); nothing testable → `tasks.py set <id> --no-tests "<reason>"`; `tasks.py plan n`; `tasks.py log keel planned "M<n> — <name> (<k> tasks)" --sha -`; one commit `keel: plan M<n>`; `tasks.py next`. Too ambiguous for runnable Done-when checks: `tasks.py add "Clarify M<n> scope" --milestone n --kind clarify`, `tasks.py block <id> "<question>"`, commit `keel: clarify M<n>` (no `plan n`). After the answer: DECISIONS row, `unblock`, work it on W without `start`, `tasks.py close <id>`, log, all in the `keel: plan M<n>` commit.
- `next: none — all blocked`: list the questions; the run ends. `next: none — done`: say so; the run ends. Never invent a milestone; new ones come from the user as SPEC.md Amendments.

## Work
- One task in progress at a time, on its branch `keel/<id>` (created or resumed by `tasks.py start <id>`).
- **Tests first.** Write the tests the task file's `## Tests` names (add the error and edge cases it missed), commit them alone as `<id>: tests`, then `python3 .claude/memory/tasks.py red <id>` — it runs the task's test command and accepts only a failing run (green means the tests do not test the task; exit 127 means the command is wrong; both are refusals: fix, commit, re-run). Only then implement. Nothing testable? `tasks.py set <id> --no-tests "<reason>"` before `red`; the reviewer judges it. A resumed task whose `next` line already shows `red:` skips this. `red` and `close` run test commands that can take minutes: call them with the Bash tool's `run_in_background: true` (or a timeout longer than the suite) and wait for the notification.
- Read ARCHITECTURE.md before creating, moving or naming a file or adding a dependency. Its `## Do NOT` list is binding. You may extend `## Module map` and `## Canonical locations` (with a DECISIONS row); `## Do NOT` and `## Approved libraries` change only with the user. Follow `## Working preferences` in this file.
- `grep -n -i "<topic>" DECISIONS.md` before any choice the architecture does not cover; append a row after (the user's chat decisions verbatim, marked `(user, chat)`). `grep -n -i "<keyword>" docs/issues.md` before debugging any error.
- Rewrite `## Now` in PROJECT_STATE.md (≤12 lines: task, done so far, in flight, next action) at every commit and before ending any turn mid-task.
- Discovered work (follow-ups, refactors, bugs found) goes to `tasks.py add` (current milestone, or `--backlog` when the milestone does not need it), never done silently inside the current task. After any abandoned approach: `tasks.py retry <id>`.
- Commits on `keel/<id>` start with the id (`004: verify webhook signature`) and stage code paths by name (`git add <paths>`), never the whole tree. Memory files (PROJECT_STATE.md, tasks.json, DECISIONS.md, docs/issues.md, docs/tasks/, …) are never committed on `keel/<id>`; they stay uncommitted until the `<id>: close`/`blocked`/`paused` commit on W. `adhoc:` only on W; `keel:` for keel's own operations.
- Never weaken, skip or delete a test to get past a gate; never record a review verdict yourself. Never run a hard reset, a forced branch create, move or delete, a force-push, a rewrite of pushed history, or a commit that skips hooks.

## Finish a task, in order
Run every Done-when check (actually run them) → commit the code on `keel/<id>` → **review**: `python3 .claude/memory/tasks.py brief <id>` and dispatch a fresh Opus subagent (Agent tool, `model: opus`) whose whole prompt is that output; it records `tasks.py review <id> pass|fail` itself; on `fail` fix every numbered reason, commit, re-dispatch. A reviewer that ends without recording a verdict (`tasks.py next` shows no `review:`) is re-dispatched once without asking; ask only if the second one also ends without a verdict. → `python3 .claude/memory/tasks.py close <id>` (gates: tests commit, `pass` review on the branch tip, task tests green, full suite green — a failing test gate costs an attempt: fix the code, commit, re-review, re-run; then it switches to W, merges `--no-ff`, records the merge sha) → append docs/issues.md entries for anything that took more than one attempt → rewrite `## Now` and `tasks.py log <id> closed "<summary>"` (log appends the merge sha; never put a sha in the summary) → commit the memory files (`<id>: close`) → `tasks.py next` immediately, no pause.

## Block or escalate
| Situation | Action |
|---|---|
| The change is outside the task's Scope, SPEC.md or ARCHITECTURE.md, touches a `## Do NOT` item, adds a dependency outside `## Approved libraries`, or the spec contradicts itself | `tasks.py block <id> "<question>"` (parks the work on `keel/<id>`); rewrite Now; `tasks.py log <id> blocked "<question> → keel/<id>" --sha <wip sha from the block output>`; commit `<id>: blocked` on W; `tasks.py next`; keep going |
| `tasks.py retry` prints `attempts exhausted` | write `Tried:` lines in docs/issues.md, then block with "attempts exhausted — <what was tried>; how to proceed?" |
| `tasks.py red` refuses (green run or exit 127) | no attempt counted: strengthen the tests so one fails for the missing behavior, or fix the command (`tasks.py set <id> --test-cmd "…"`); commit `<id>: tests`; re-run `red`. Genuinely nothing testable → `tasks.py set <id> --no-tests "<reason>"` |
| The reviewer records `fail` | fix every numbered reason, commit, `brief` + dispatch a fresh reviewer again (each fail costs an attempt); at `attempts exhausted` write `Tried:` lines and block with "review failed 3 times — <last reasons>; how to proceed?" |
| `tasks.py close` fails a test gate (`task tests failed` / `full suite failed`) | one attempt counted: fix the code, never the gate; commit; re-review (the commit made the review stale); re-run `close`; at exhaustion block as above |
| `tasks.py close` refuses a gate without counting (no tests commit, no review, review older than the branch tip) | do the missing step (`red`, or `brief` + reviewer), then re-run `close` |
| Destructive or outward-facing action (deleting data, deploy, spending money, credentials, anything irreversible outside the repo) | never on your own initiative: `tasks.py block <id> "needs approval: <exact action and why>"`, then as the first row; continue the queue. Perform it only after an explicit yes in chat: DECISIONS row (verbatim), `tasks.py unblock <id>`, print the goal line |
| User answers a question or approves an action | DECISIONS.md row (verbatim, `(user, chat)`); `tasks.py unblock <id>`; print the goal line for the user to paste; `tasks.py start <id>` only if nothing is in progress |
| `start` or `close` stops on a merge or stash conflict | task-specific: resolve it, `git add` the files (`start`: then `git commit`; stash: `git stash drop <ref>`), re-run the same command. Unresolvable: `git merge --abort`, `git switch keel/<id>`, `tasks.py block <id> "merge conflict in <files>: <why>"` |
| Any other `tasks.py` failure (preflight, not on W, a rejected commit, memory committed on the task branch, a stale `keel/<id>` ref, no POSIX shell) | repo-level, never the task's fault: print the failed command, its output and the current branch; never bypass it; rewrite Now; print `[keel] run halted: <reason>` once; the run ends for the user to intervene |
| User says stop or pause (now, or after some step) | finish the current step (or the named one); rewrite Now; print `[keel] stopped: <where things stand>`; stop |

## Files
| File | Read when | Update when |
|---|---|---|
| PROJECT_STATE.md | session start, always (injected; else `tasks.py state`) | `## Now` at every commit and before ending any turn mid-task; one Log line via `tasks.py log` at task close/block/drop/pause, milestone plan, and code-changing ad-hoc requests |
| tasks.json via `tasks.py next` | session start and after every close/block/pause/drop/plan | only through `tasks.py` (`start`/`red`/`review`/`close`/`block`/`pause`/`unblock`/`drop`/`reopen`/`add`/`set`/`retry`/`plan`; `set-work-branch` only when the user asks) |
| docs/tasks/<id>-<slug>.md | starting that task (`## Tests` is the list of tests to write first) | only if the user changes scope; scope growth is a new task with a dep |
| .claude/memory/review-prompt.md via `tasks.py brief <id>` | when dispatching the reviewer | never by hand; `upgrade` overwrites it |
| .claude/memory/keel.json | never directly | `test_command` once, by task 002's Done-when (the one-command suite); caps never raised |
| ARCHITECTURE.md | before creating/moving/naming a file or adding a dependency | `## Module map` / `## Canonical locations` when a task adds one (with a DECISIONS row); `## Do NOT` / `## Approved libraries` only with the user |
| DECISIONS.md | grep before a choice the architecture does not cover | after any such choice, including the user's chat decisions |
| docs/issues.md | grep before debugging any error | after solving anything that took >1 attempt |
| SPEC.md | only the sections the task cites; `### M<n>` when `next` prints `plan M<n>` | never in place; append `## Amendment N — <date>` sections |

## Rules
SPEC.md changes only by appended Amendment sections. TASKS.md is generated: never read or edit it. Never raise a cap to make a file fit; run `/keel tidy`. When the handoff nudge fires or context must be reset, tell the user: type `/clear`, then paste the goal line (you cannot run `/clear` or `/goal`). Unattended goal runs need auto mode. A `tasks.py` git failure is reported verbatim (command, output, current branch) and never worked around; a repo-level failure ends the run with one `[keel] run halted: <reason>` line and is never parked onto the task.

## Goal line (for the user to paste, verbatim)
```
/goal Work the keel task queue per CLAUDE.md. Judge only what Claude printed after the most recent line reading "[keel] goal run started"; ignore everything before that line. Done when, after that line, Claude has run `python3 .claude/memory/tasks.py next` and it printed a line starting "next: none — done", OR it printed "next: none — all blocked" and Claude has listed the open questions, OR Claude has printed a line starting "[keel] run halted:", OR Claude has printed a line starting "[keel] stopped:" (a stop or pause request alone does not end it).
```
<!-- /keel -->
