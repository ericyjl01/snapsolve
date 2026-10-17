# 055 · First release into the claude-skills marketplace and install on this Mac

## Objective
The release half of the archived 026, on the Mac (Amendment 4): put snapsolve into Eric's `claude-skills` marketplace on this Mac and install it from there, so `docs/checklists/macos.md` item 1 (`/snapsolve install`) can run.

## Scope
In:  one real `node scripts/release.mjs --target ~/claude-setup/plugins/claude-skills` (the marketplace Claude Code has registered as `claude-skills`, a local directory, not a git repo) — only after Eric's explicit yes, because the write cannot be rolled back; `claude plugin install snapsolve@claude-skills`; recording in `## Notes` whether `/snapsolve` or `/snapsolve:snapsolve` is the working command.
Out: the checklist itself (032); signing/notarization (non-goal); Windows (archived).

## Done when
- [ ] Eric approved the release in chat (DECISIONS row) and `node scripts/release.mjs --target ~/claude-setup/plugins/claude-skills` exited 0
- [ ] `claude plugin install snapsolve@claude-skills` succeeded and `/snapsolve doctor` runs
- [ ] PROJECT_STATE.md `## Now` tells Eric 032 can start

## Tests
None (no-tests: one approved release run plus a manual install; release.mjs and the installer are tested in 022–025, 031).

## Spec refs
SPEC §8.1, Amendment 4; DESIGN §4, §5.

## Notes
The old default target (`~/.claude/claude-setup-source/plugins/claude-skills`) was the Windows PC's layout and does not exist on this Mac; pass `--target`.
