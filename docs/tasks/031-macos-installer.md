# 031 · macOS installer branch

## Objective
DESIGN §4.1–4.3 on macOS: `/snapsolve install|start|update|doctor|uninstall` work on a Mac with a stable app identity, so the Screen Recording grant survives code updates.

## Scope
In:  installer steps/commands (023/024) darwin branches: preflight darwin ok (Node offer `brew install node`); packager → `~/Applications/snapsolve.app` (`mkdir -p ~/Applications`; `appBundleId: "com.snapsolve.app"`, `extendInfo: { LSUIElement: true }`, `icon` .icns when present); `codesign --force --deep --sign - ~/Applications/snapsolve.app` once, only when the bootstrap is (re)packaged; launch `open -a ~/Applications/snapsolve.app` with `CLAUDECODE`/`CLAUDE_CODE_*` removed; quit-and-wait via the bundle's binary `--quit`; `current` as a symlink; update re-packages and re-signs only when the Electron version changed and then says macOS will ask for Screen Recording again; uninstall removes the .app. SKILL.md: brew offer, Screen Recording walkthrough + Relaunch after install, the re-prompt note on Electron updates.
Out: Windows behavior (unchanged); app code (030).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/installer-steps.test.ts test/unit/installer-commands.test.ts test/unit/skill.test.ts`
- darwin preflight passes (Node ≥ minimum) and offers `brew install node` when Node is missing.
- packageBootstrap darwin: packager options include `appBundleId`, `extendInfo.LSUIElement: true`, darwin platform; output lands at `<home>/Applications/snapsolve.app` (dir created); codesign called once with exactly `--force --deep --sign -` and the .app path.
- update with an unchanged Electron → no packager, no codesign; changed Electron → both, and a `warn:` about the Screen Recording re-prompt.
- launch uses `open -a <app>` with `CLAUDECODE`/`CLAUDE_CODE_*` stripped; uninstall removes the .app and keeps history unless purged.
- `current` is a symlink on darwin (injected fs).
- SKILL.md install section mentions `brew install node`, the Screen Recording grant and Relaunch.

## Spec refs
SPEC §8.1, §9.1; DESIGN §4.1–4.3, §7.

## Notes
Built on Windows with injected fakes; the real install runs in 032 on Eric's Mac. Ad-hoc signatures change identity on every re-sign, hence "sign once, never on code-only updates".
