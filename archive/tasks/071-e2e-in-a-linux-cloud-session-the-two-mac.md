# 071 · e2e in a Linux cloud session: the two macOS-only assertions

## Objective
`npm test` in a Linux cloud session is 876/878: every unit, integration and e2e test passes but two e2e assertions
about macOS/Windows-only behaviour, so no task can pass keel's close gate there. Make the suite state what it means —
these two checks belong to a supported platform — without losing them on the Mac, which is the only platform snapsolve
supports (SPEC Amendment 4).

## Scope
In:
- `test/e2e/panel.e2e.test.ts` "is content-protected, has the CSP meta, …": `win.isContentProtected()` is false on
  Linux because `setContentProtection` is a macOS/Windows API (probe: `PLATFORM=linux isContentProtected=false`).
  Assert it only where Electron implements it; the rest of that test (CSP meta, `window.open`, the twelve preload
  names, no `require`/`process`, the URL, no navigation away) runs everywhere and stays as it is.
- `test/e2e/userdata.e2e.test.ts` "without the override: userData is <platform data dir>/electron": main exits with
  `snapsolve: unsupported platform: linux` (Amendment 4), so the launch times out at 30 s. Skip the test where the app
  refuses to start, and say so in the skip reason — not a silent pass.
- One place that names the rule (a helper such as `onlyOnSupportedPlatform` in `test/e2e/helpers.ts`), so a third such
  test does not invent its own check.
- docs/issues.md already records how the container runs e2e (hand-unzipped Electron, `ELECTRON_DISABLE_SANDBOX=1
  xvfb-run -a`); add the one-line pointer from here if the task changes it.
Out: making the app itself run on Linux (Amendment 4 says macOS only); CI; any change to what the app does on macOS.

## Done when
- [ ] `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx vitest run test/e2e/panel.e2e.test.ts test/e2e/userdata.e2e.test.ts`
      exits 0 in a Linux cloud session, with the two platform checks reported as skipped and a reason, not passed
- [ ] `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npm test` exits 0
- [ ] On the Mac: `npm test` exits 0 and both checks actually run (the content-protection assertion and the userData
      test are not skipped there)

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts test/e2e/userdata.e2e.test.ts`
- "content protection is asserted on a platform that implements it" — proves the assertion still runs on darwin and is
  skipped, with a reason, where Electron does not implement it
- "the userData test is skipped where the app refuses to start" — proves the skip is keyed to the platform the app
  supports, not to a swallowed launch failure
- The rest of both files are unchanged and must stay green: they are the regression check for this task.

## Spec refs
SPEC Amendment 4 (macOS only); SPEC §2.2 content protection; `src/main/panel.ts` `setContentProtection`;
`src/main/main.ts` unsupported-platform exit; `test/e2e/helpers.ts`.

## Notes
Found while closing 065 in the first cloud session. Needs Eric's answer on 065's block question first: platform-gate
these two (this task), or close tasks only on the Mac (then this task is dropped).
