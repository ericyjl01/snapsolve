# 011 · Error states, auth and usage surfacing

## Objective
SPEC §3.6 and §7.1: every failure shows the right message and action on the card; usage is visible.

## Scope
In:  `src/main/auth.ts` (`checkAuth({ execFile, claudePath })` → `{ loggedIn, authMethod, subscriptionType }` from `claude auth status`; `formatUsage(info)` → "5h N% · 7d M%"; `isUsageBlocked(info)` + local reset time); wiring in `app.ts`/`main.ts`: startup auth check, recheck after any error result, apiKeySource warning, usage-blocked message before spawning, error kinds → card messages, tray tooltip usage.
Out: macOS permission card (M3).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/auth.test.ts test/integration/errors.integration.test.ts test/e2e/errors.e2e.test.ts`
- auth unit: JSON `loggedIn` true/false parsed; non-zero exit with JSON → loggedIn false; ENOENT → `claudeNotFound`; malformed output → `unknown`, no throw; email/org fields never logged or returned.
- usage unit: rounding to whole percents; missing window omitted; status other than `allowed` → blocked with a formatted reset time.
- integration (fake claude): `not-logged-in` → error kind `notLoggedIn`; `api-key` init source → warning event; `rate-limited` → usage-blocked status and no further spawn until reset.
- e2e: missing claudePath → card text exactly "Claude Code not found. Run /snapsolve install."; `hang` with small timeout → Retry visible; switching the fake to `ok` and clicking Retry → answer rendered.

## Spec refs
SPEC §3.6, §7.1.

## Notes
