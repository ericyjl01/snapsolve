# 028 · macOS login-shell PATH for claude

## Objective
SPEC §3.2 / DESIGN §3.3: on macOS, `claude` started from a Finder/`open -a` launch finds Node and itself — the env the runner spawns with has the login-shell PATH merged in, read once at startup.

## Scope
In:  `src/main/runner.ts` exported pure `withLoginShellPath(env, { platform, home, shell, execFileSync })`: darwin → runs `<SHELL or /bin/zsh> -ilc 'printf %s "$PATH"'` (timeout 3000 ms), merges login PATH first, then the existing PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, `<home>/.local/bin`; duplicates and empty entries dropped, order kept. Shell failure, timeout or empty output → existing PATH + the three extras, plus a returned warning (never throws). Any other platform → env unchanged, no shell run. `test/unit/runner.test.ts`.
Out: calling it at startup (030, main.ts); `claudePath` resolution (installer).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/runner.test.ts`
- darwin: login PATH `/opt/homebrew/bin:/usr/bin` + env PATH `/usr/bin:/bin` → `/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin:<home>/.local/bin` (dedup, order kept); the shell is `$SHELL` with `-ilc` and a 3000 ms timeout.
- darwin, no `SHELL` → `/bin/zsh`.
- darwin, shell throws / times out / prints nothing → existing PATH + extras, a warning naming the shell, no throw.
- win32 and linux → returned env equals the input; `execFileSync` never called.
- The input env object is not mutated; other keys pass through unchanged.
- `buildEnv(withLoginShellPath(...), …)` still strips `CLAUDECODE*`/API keys (composition holds).

## Spec refs
SPEC §3.2; DESIGN §3.3 (env), §7 (claude PATH row); ARCHITECTURE conventions (platform passed in, DI).

## Notes
The npm shim `claude` is `#!/usr/bin/env node`, so Node must be on PATH; GUI-launched macOS apps get launchd's minimal PATH.
