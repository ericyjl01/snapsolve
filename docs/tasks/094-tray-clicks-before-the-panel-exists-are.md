# 094 · tray clicks before the panel exists are ignored, not thrown (main.ts startup)

## Objective
Found in 090's review: src/main/main.ts creates the tray (~line 118) before `const panel = createPanel(…)` (~line 177), with awaits in between (readSystemPrompt, recoverBusyThreads). A tray click in that gap (Open snapsolve, Reset window position, Transparency ›) reaches `panel` in its temporal dead zone, throws a ReferenceError, and with no uncaught-exception handler Electron shows its error dialog. The gap is short but real on a slow start.

## Scope
In:
- Tray handlers that need the panel do nothing (and log `tray.beforePanel` once with the item) until the panel exists; or the tray is created after the panel. Whichever keeps the 088 timing (window shown right after the grab) and the tray's appearance time unchanged.
- A unit test of the chosen wiring.
Out: an app-wide uncaught-exception handler; any other startup reordering.

## Done when
- [ ] `npx vitest run test/unit/app.test.ts` passes
- [ ] `npm test` is green
- [ ] unit: a tray handler called before the panel exists does not throw and logs once; after the panel exists it reaches the panel

## Tests
Command: `npx vitest run test/unit/app.test.ts`
- onOpenPanel / onResetPosition / onTransparency before the panel → no throw, one `tray.beforePanel` log each, panel untouched
- the same handlers after the panel exists → panel.toggle / resetPosition / setTransparency called once
- edge: a Transparency pick before the panel is still saved to config (or explicitly dropped; the test says which)

## Spec refs
SPEC §1.2, §4.1; tasks 058, 090.

## Notes
Backlog (reviewer of 090, 2026-10-23). Same pattern predates 090 for Open and Reset.
