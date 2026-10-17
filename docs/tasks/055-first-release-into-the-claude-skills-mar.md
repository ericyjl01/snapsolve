# 055 · Local install on this Mac (no claude-skills release)

## Objective
snapsolve lives only on Eric's Mac (DECISIONS 2026-10-17: "I just want it to live locally"). Nothing goes into the `claude-skills` marketplace. Assemble the plugin into a private local marketplace and add it to Claude Code on this Mac, so `/snapsolve install` (checklist item 1, task 032) works.

## Scope
In:  `~/dev/snapsolve-local/` (outside the repo; a one-plugin marketplace: `.claude-plugin/marketplace.json` named `snapsolve-local`); `npm run build` + `node scripts/release.mjs --target ~/dev/snapsolve-local`; `claude plugin marketplace add ~/dev/snapsolve-local` + `claude plugin install snapsolve@snapsolve-local`; recording in `## Notes` whether `/snapsolve` or `/snapsolve:snapsolve` is the working command.
Out: `~/claude-setup/plugins/claude-skills` (never written); running `/snapsolve install` itself (Eric, checklist item 1 in 032); signing (non-goal).

## Done when
- [ ] `node scripts/release.mjs --target ~/dev/snapsolve-local` exited 0 and `~/dev/snapsolve-local/plugins/snapsolve/app/` exists
- [ ] `claude plugin marketplace list` shows `snapsolve-local` and `claude plugin install snapsolve@snapsolve-local` succeeded
- [ ] `node ~/dev/snapsolve-local/plugins/snapsolve/skills/snapsolve/scripts/snapsolve.mjs doctor` runs (fail: lines for "not installed yet" are expected)
- [ ] PROJECT_STATE.md `## Now` tells Eric 032 can start

## Tests
None (no-tests: a local release and plugin registration; release.mjs and the installer are tested in 022–025, 031).

## Spec refs
SPEC §8.1, Amendment 4; DESIGN §4, §5.

## Notes
To undo: `claude plugin uninstall snapsolve@snapsolve-local`, `claude plugin marketplace remove snapsolve-local`, delete `~/dev/snapsolve-local`. Later code changes reach the installed app by re-running the release (bump `version` in package.json first) and `/snapsolve update`.
