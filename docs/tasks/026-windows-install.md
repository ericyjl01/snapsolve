# 026 · Windows install verification and first release

## Objective
M2 done on a real machine: the plugin is released into Eric's `claude-skills` marketplace and `/snapsolve install` → hotkey → answer works on an unmanaged Windows PC; the parts that need a person are a checklist for Eric.

## Scope
In:  `docs/checklists/windows-install.md`; one real `node scripts/release.mjs` run into `~/.claude/claude-setup-source/plugins/claude-skills` — only after Eric's explicit yes (`tasks.py block 026 "needs approval: …"` first; claude-setup-source is not a git repo, so the write cannot be rolled back); fixes found by the checklist become new tasks.
Out: macOS (M3); signing (DECISIONS 020); INSTALL.md / settings.json changes in claude-setup-source.

## Done when
- [ ] Eric approved the release in chat (DECISIONS row) and `node scripts/release.mjs` exited 0 into the real marketplace
- [ ] `docs/checklists/windows-install.md` lists, for an unmanaged Windows PC: `claude plugin marketplace add` + `claude plugin install snapsolve@claude-skills`; `/snapsolve install` (and whether the short `/snapsolve` works or `/snapsolve:snapsolve` is needed); tray icon and Ctrl+Alt+Q → card with an answer; Start-menu shortcut starts it; `/snapsolve doctor` all ok; update after a version bump keeps history; uninstall keeps history; uninstall + purge removes the data dir. For this managed PC: `/snapsolve doctor` reports the ASR block with the IT-exclusion hint
- [ ] PROJECT_STATE.md `## Now` tells Eric which checklist items remain

## Tests
None (no-tests: manual checklist plus one approved release run; the code is tested in 021–025).

## Spec refs
SPEC §8.1, Milestones `### M2`; DESIGN §4, §5, §10 risk 6; DECISIONS 2026-10-14 (020).

## Notes
Waits on 013 (M1 Windows verification) because an installed app is only worth checking once the M1 app works end to end; 013 waits on 015 (Mac).
