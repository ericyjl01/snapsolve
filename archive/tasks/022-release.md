# 022 · Plugin skeleton and release script

## Objective
SPEC §8.1 / DESIGN §4, §5: `scripts/release.mjs` assembles the `snapsolve` plugin into a `claude-skills` marketplace folder: plugin manifest, skill, installer scripts and an `app/` payload the installer can stage without building anything.

## Scope
In:  `plugin/.claude-plugin/plugin.json` (`name: "snapsolve"`, description, author; `version` filled in by release); `plugin/skills/snapsolve/SKILL.md` placeholder (frontmatter only; 025 writes it); `scripts/release.mjs`: exported `assemble({ root, target })` (no build, no network) + CLI `node scripts/release.mjs [--target <marketplace root>]` that runs `npm run build` then `assemble` (default target `~/.claude/claude-setup-source/plugins/claude-skills`, printed before writing). Output `<target>/plugins/snapsolve/`: everything under `plugin/`, plus `app/` = `dist/main.js`, `dist/preload.js`, `dist/renderer/**`, `prompts/**`, `assets/**` (if present), `bootstrap/{boot.js,package.json}`, `package.json` (root's, with `main: "main.js"` and no `scripts`) and the root `package-lock.json` verbatim. `@electron/packager` (approved) added as an exact runtime `dependency` so `npm ci --omit=dev` in the staged app installs it. Marketplace entry and README row added once. ARCHITECTURE module map: `scripts/release.mjs` (already listed) and the `app/` payload layout; DECISIONS rows for the payload (SPEC §8.1's "source" = the built JS, since `boot.js` requires `current/main.js`) and the packager dependency.
Out: running the release against the real marketplace (026, needs Eric's approval); INSTALL.md / settings.json in claude-setup-source (snapsolve stays opt-in); installer scripts' content (023/024).

## Done when
- [ ] task tests pass; `npm run build` exits 0; `npm ci --omit=dev --ignore-scripts` succeeds in a staged `app/` copy (run once by hand in a temp dir; note the result in the task log)

## Tests
Command: `npx vitest run test/unit/release.test.ts`
All against a temp marketplace fixture (`.claude-plugin/marketplace.json` with two other plugins, `README.md` with a plugin list) and a temp fake repo root with a pre-built `dist/`.
- The assembled tree under `plugins/snapsolve/` is exactly the expected file list (manifest, skill, scripts, app payload incl. `app/bootstrap/`); no `node_modules`, `*.map`, `src/`, `test/` or dotfiles beyond `.claude-plugin/`.
- `plugin.json` `version` equals root `package.json` version; `app/package.json` has `main: "main.js"`, the same version, no `scripts`, `@electron/packager` in `dependencies` at an exact version; `app/package-lock.json` is byte-identical to the root lockfile and its root entry lists the same `dependencies`.
- marketplace.json gains exactly one `{ name: "snapsolve", source: "./plugins/snapsolve", description }`; the other entries keep order and content; a second run adds nothing.
- README gains exactly one snapsolve row in the plugin list; a second run adds nothing.
- A re-run removes files that an earlier release had and this one does not (stale file planted in `plugins/snapsolve/` → gone).
- Same version already released with different `app/` content → refuses ("bump the version"), writes nothing; identical re-run → success, no change.
- Target without `.claude-plugin/marketplace.json` → error, nothing written. `dist/main.js` missing → error naming `npm run build`.
- No text file in the output contains `\r\n`.

## Spec refs
SPEC §8.1, Milestones `### M2`; DESIGN §4, §5; DECISIONS 2026-10-13 (app at repo root, plugin assembled by release.mjs; `.gitattributes` LF).

## Notes
Claude Code docs (fetched 2026-10-14, plugins/loading): a marketplace added from a local path loads relative-path plugins in place (no cache copy, no npm run), which is how claude-setup-source is shared; `plugin.json` `version` wins over the marketplace entry. claude-setup-source is not a git repo — a real release cannot be rolled back, hence the approval in 026.
Answer (2026-10-14, after 3 failed reviews): raise the Node minimum to 22.12 and keep `@electron/packager` 20.3.0 (DECISIONS row). On keel/022: DESIGN §4.2 preflight says Node ≥ 22.12; the node_modules-exclusion test plants a `node_modules/` in the fake root and proves it is not copied; then one more review. Attempts reset to 1 on unblock.
