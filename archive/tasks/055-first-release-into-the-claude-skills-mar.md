# 055 · Local install on this Mac (no claude-skills release)

## Objective
snapsolve lives only on Eric's Mac (DECISIONS 2026-10-17: "I just want it to live locally"). Nothing goes into the `claude-skills` marketplace. Assemble the plugin into a private local marketplace and add it to Claude Code on this Mac, so `/snapsolve install` (checklist item 1, task 032) works.

## Scope
In:  `~/dev/snapsolve-local/` (outside the repo; a one-plugin marketplace: `.claude-plugin/marketplace.json` named `snapsolve-local`); `npm run build` + `node scripts/release.mjs --target ~/dev/snapsolve-local`; `claude plugin marketplace add ~/dev/snapsolve-local` + `claude plugin install snapsolve@snapsolve-local`; recording in `## Notes` whether `/snapsolve` or `/snapsolve:snapsolve` is the working command.
Out: `~/claude-setup/plugins/claude-skills` (never written); running `/snapsolve install` itself (Eric, checklist item 1 in 032); signing (non-goal).

## Done when
- [x] `node scripts/release.mjs --target ~/dev/snapsolve-local` exited 0 and `~/dev/snapsolve-local/plugins/snapsolve/app/` exists
- [x] `claude plugin marketplace list` shows `snapsolve-local` and `claude plugin install snapsolve@snapsolve-local` succeeded
- [x] `node ~/dev/snapsolve-local/plugins/snapsolve/skills/snapsolve/scripts/snapsolve.mjs doctor` runs (fail: lines for "not installed yet" are expected)
- [x] PROJECT_STATE.md `## Now` tells Eric 032 can start

## Tests
None (no-tests: a local release and plugin registration; release.mjs and the installer are tested in 022–025, 031).

## Spec refs
SPEC §8.1, Amendment 4; DESIGN §4, §5.

## Notes
To undo: `claude plugin uninstall snapsolve@snapsolve-local`, `claude plugin marketplace remove snapsolve-local`, delete `~/dev/snapsolve-local`. Later code changes reach the installed app by re-running the release (bump `version` in package.json first) and `/snapsolve update`.

2026-10-17 results: `~/dev/snapsolve-local/.claude-plugin/marketplace.json` (name `snapsolve-local`, owner Eric, plugins []) and a README.md table were created by hand, then `node scripts/release.mjs --target ~/dev/snapsolve-local` exited 0 (snapsolve 0.1.0; app/ holds main.js, preload.js, renderer/, prompts/, bootstrap/, package.json, package-lock.json). `claude plugin marketplace add ~/dev/snapsolve-local` (user settings) and `claude plugin install snapsolve@snapsolve-local` (scope user, enabled) succeeded; `marketplace list` shows `snapsolve-local` (Directory). `snapsolve.mjs doctor`: ok Node v26.5.0, ok Claude Code 2.1.302, ok logged in; fail "snapsolve is not installed: run /snapsolve install" (expected), exit 1.
Command name: the plugin skill is `snapsolve:snapsolve` (plugin `snapsolve`, skill `skills/snapsolve`), so `/snapsolve:snapsolve install` is the guaranteed form; whether bare `/snapsolve install` resolves could not be checked here (plugins load at session start). Eric: in a new session type `/snapsolve` and use whichever the autocomplete offers; note it in 032's item 1.
Found: the release's README row says "(Windows desktop app)" → backlog task.
