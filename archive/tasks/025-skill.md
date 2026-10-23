# 025 · SKILL.md for /snapsolve

## Objective
`/snapsolve install|start|update|doctor|uninstall` (SPEC §8.1): the skill tells Claude exactly which installer command to run, what to ask the user, and what to tell them, per DESIGN §4.2–4.3.

## Scope
In:  `plugin/skills/snapsolve/SKILL.md`: frontmatter (`name: snapsolve`, a description naming the five subcommands, `disable-model-invocation: true` so it only runs when the user types it); one section per subcommand running `node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" <cmd>` and relaying its `ok:`/`warn:`/`fail:` lines; no or unknown argument → list the subcommands. install: Node missing/old → offer `winget install OpenJS.NodeJS.LTS` and run it only after a yes; Pro-plan note (Opus/high uses the weekly Opus allowance faster; tray tooltip shows 5h/7d; `model: "sonnet"` in config.json if needed); AltGr note (Ctrl+Alt = AltGr on German/French/Polish layouts); corporate networks (`ELECTRON_MIRROR`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`). doctor: after the script, ask "Press Ctrl+Alt+Q now — did a card appear with an answer?". uninstall: ask before deleting history; only then `--purge`. `test/unit/skill.test.ts`. DESIGN §10 risk 1 marked resolved (see Notes).
Out: installer behavior (023/024); macOS steps (M3).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/skill.test.ts`
- Frontmatter parses; `name` is `snapsolve`; description names install, start, update, doctor, uninstall; `disable-model-invocation: true`.
- Each of the five subcommands has a section whose command is `node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" <that subcommand>`, and that script path exists under `plugin/`.
- Every plugin-root reference is the braced `${CLAUDE_PLUGIN_ROOT}` with forward slashes (Claude Code substitutes it in the body; it is not an env var in Bash).
- `--purge` appears only in the uninstall section, after the instruction to ask the user first.
- install section contains the winget offer, the Pro-plan note, the AltGr note and all three proxy variables; doctor section contains the Ctrl+Alt+Q question.
- No `\r\n`; no absolute user paths (`C:\Users`, `/Users/`).

## Spec refs
SPEC §8.1; DESIGN §1.1 (AltGr note), §4.2, §4.3.

## Notes
Claude Code docs (skills, "String substitutions"; plugins/manifest-reference, "Environment variables", fetched 2026-10-14): `${CLAUDE_PLUGIN_ROOT}` is substituted inline in a plugin skill's body and is not exported to Bash — this resolves DESIGN §10 risk 1. Plugin skills are documented as `/snapsolve:snapsolve`; whether the short `/snapsolve` form works is checked in 026.
