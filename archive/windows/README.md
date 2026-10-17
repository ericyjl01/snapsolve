# Windows support — archived 2026-10-17

snapsolve is macOS only from 2026-10-17 (SPEC Amendment 4; DECISIONS 2026-10-17, Eric in chat). This folder records
what the Windows side is and how to pick it up again. Nothing was deleted.

## State when archived
- **Built and unit-tested, never run end to end on Windows:** the win32 code paths in the app (content-protected panel,
  tray balloon notifications, `%LOCALAPPDATA%\snapsolve` data dir, `windowsHide`, `claude.exe` lookup) and the installer
  (`plugin/skills/snapsolve/scripts/`: Programs folder + Start-menu shortcut, junction for `current`, Defender ASR check
  in `doctor`). Their tests still run on every `npm test` (most mock `process.platform`).
- **Live tests:** `docs/live-results.md` was measured on Windows 11 (2026-10-14); the Mac has not had a live run yet.
- **Never done:** task 013 (Windows end-to-end checks + `docs/checklists/windows.md`, never written) and task 026
  (Windows install check; its first-release half moved to task 055 on the Mac). Both are `dropped` in tasks.json.
- **Leftovers on the old Windows PC:** a stale `%APPDATA%\snapsolve` folder (from before 014 moved Electron's userData),
  and the Defender ASR rule that blocks the app there (needs an IT exclusion).

## To resume
1. Append a SPEC amendment bringing Windows back (and undo Amendment 4's "inactive" list).
2. `python3 .claude/memory/tasks.py reopen 013 "<why>"` and `reopen 026 "<why>"`; read their task files
   (`docs/tasks/013-windows-verify.md`, `docs/tasks/026-windows-install.md`) — 026's release step is already done by 055.
3. Needs an unmanaged Windows PC with Node ≥ 22.12 and Claude Code (`claude.exe`) logged in.
