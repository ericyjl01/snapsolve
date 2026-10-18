---
name: snapsolve
description: Install and manage the snapsolve desktop app (hotkey screen capture → step-by-step answer from Claude in a side panel). Subcommands are install, start, update, doctor, uninstall.
argument-hint: install | start | update | doctor | uninstall
disable-model-invocation: true
---

# /snapsolve

The user typed `/snapsolve $ARGUMENTS`.

The first word of those arguments is the subcommand: `install`, `start`, `update`, `doctor` or `uninstall`. Follow that section below and nothing else. If there is no argument, or it is not one of these five, run nothing: list the five subcommands with their one-line purpose and stop.

- `install`: set up snapsolve on this PC and start it.
- `start`: start snapsolve if it is not running.
- `update`: switch to the version that came with this plugin.
- `doctor`: check that everything snapsolve needs works.
- `uninstall`: remove snapsolve (asks before deleting history).

How every subcommand works: run the one command its section names with the Bash tool, exactly as written (the quotes stay; do not change directory first). It prints one line per result, each starting `ok:`, `warn:` or `fail:`, and exits 0 when nothing failed, 1 when something did. It never asks questions; you do the asking, as each section says. Tell the user what the lines say in plain words, keep every path, version and command exact, report `fail:` lines first, and never claim a step the output does not show. snapsolve runs on Windows and macOS; on another OS the script says so.

## install

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" install
```

It checks Node, Claude Code and its login, installs the app into the user's local app data, builds the launcher (first install only, downloads Electron) — on Windows with a Start-menu shortcut, on macOS as `~/Applications/snapsolve.app` — and starts snapsolve.

- **Node missing or too old** (`node` is not found, or a `fail:` line says Node is too old; snapsolve needs Node 22.12 or newer): offer to install the current LTS with `winget install OpenJS.NodeJS.LTS` on Windows, or `brew install node` on macOS. Run it only after they say yes. Then run the install command again; if `node` is still not found, ask the user to restart Claude Code (new installs reach PATH only in new sessions) and run `/snapsolve install` again.
- **Claude Code not logged in**: tell them to run `claude` once in a terminal and log in, then run `/snapsolve install` again.
- **Defender ASR blocks the launcher** (Windows; a `fail:` line naming Defender ASR): the PC's security policy stops unsigned apps; only their IT can add an exclusion for the exe the line names. Nothing on this PC can work around it, and do not try.
- **Corporate network** (npm or the Electron download fails with a certificate, proxy or timeout error): ask the user for their network details and set them for the command, then run it again: `HTTPS_PROXY` (the proxy URL), `NODE_EXTRA_CA_CERTS` (path to the company root certificate, a .pem file) and `ELECTRON_MIRROR` (an internal mirror of the Electron downloads, if IT has one). Never guess the values.

When it succeeds, tell the user:

- snapsolve runs in the notification area (Windows) or the menu bar (macOS), and the hotkey the output names (Ctrl+Alt+C on Windows, Ctrl+Option+C on macOS, unless they changed it) captures the screen and opens the answer panel.
- **Show/hide**: Ctrl+Option+X (Ctrl+Alt+X on Windows; `hotkeys.toggle` in config.json) shows the snapsolve window or hides it completely; the menu-bar item Show/Hide snapsolve does the same.
- **Screen Recording (macOS)**: walk them through it. The first capture makes macOS ask for Screen Recording; they turn snapsolve on in System Settings → Privacy & Security → Screen Recording, then click Relaunch on the snapsolve card (macOS only applies the grant to a restarted app). Until then the card offers Open System Settings and Relaunch.
- **AltGr** (Windows): on German, French and Polish keyboard layouts Ctrl+Alt is the same as AltGr, so Ctrl+Alt+C also catches AltGr+C (that types ć on a Polish keyboard). If they need that key, change `hotkeys.capture` in the config.json the output names.
- **Pro plan**: snapsolve answers with Opus at high effort, which uses a Pro plan's weekly Opus allowance faster. The tray tooltip shows the 5-hour and 7-day usage. To save allowance, set `"model": "sonnet"` in config.json and restart snapsolve.

## start

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" start
```

If it says snapsolve is not installed, offer `/snapsolve install`. If it says Defender ASR blocks the launcher, explain as in the install section.

## update

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" update
```

It quits snapsolve, switches to the plugin's version and starts it again; history and settings stay. "Up to date" means there is nothing to do. On macOS, a `warn:` line saying snapsolve.app was rebuilt and signed again means macOS will ask for Screen Recording again: walk them through the grant and Relaunch as after install, and if the toggle looks stuck, remove the old snapsolve entry from the Screen Recording list first. If it says snapsolve is still running, ask the user to quit it from its tray icon, then run the command again. If it says snapsolve is not installed, offer `/snapsolve install`.

## doctor

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" doctor
```

Report every `fail:` and `warn:` line with its fix (the install section explains the Node, login and Defender ASR ones; an older installed version means `/snapsolve update`). Then ask:

> Press Ctrl+Alt+C now — did a card appear with an answer?

On a Mac, say Ctrl+Option+C instead. Read `hotkeys.capture` in the config file first (`%LOCALAPPDATA%\snapsolve\config.json` on Windows, `~/Library/Application Support/snapsolve/config.json` on a Mac): if it is set to another hotkey, ask with that one.

If no card appeared: check that the snapsolve icon is in the tray (the menu bar on a Mac; `/snapsolve start` if not), whether a notification said the hotkey is taken by another app, and read the newest lines of the log (`%LOCALAPPDATA%\snapsolve\logs\snapsolve.log` on Windows, `~/Library/Application Support/snapsolve/logs/snapsolve.log` on a Mac).

## uninstall

Ask the user first: should their snapsolve history (screenshots, answers and conversations), settings and logs be deleted too, or kept? Deleting cannot be undone.

- They want everything deleted (an explicit yes) → run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" uninstall --purge
```

- Anything else → run:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/snapsolve/scripts/snapsolve.mjs" uninstall
```

Either way it quits snapsolve and removes the app, its launcher and (on Windows) the Start-menu shortcut. With the plain uninstall the history, config and logs stay where the output says, and a later `/snapsolve install` picks them up again.
