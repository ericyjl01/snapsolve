# 013 · Windows end-to-end verification and checklist

## Objective
Automate the Windows checklist items that can be automated; list the rest for Eric.

## Scope
In:  `test/e2e/windows.e2e.test.ts` using real `desktopCapturer` (fake claude): capture through the same function the hotkey calls; in test mode the panel background is a marker color (`#ff00ff`). `docs/checklists/windows.md` with the manual items.
Out: macOS (M3), installer (M2).

## Done when
- [ ] task tests pass
- [ ] `docs/checklists/windows.md` lists: hotkey from Outlook, Edge and Explorer; no console flash; panel never takes focus; panel absent from a Teams screen share and from Snipping Tool; sleep/resume keeps hotkeys; usage tooltip; real-claude answer quality on a real problem
- [ ] PROJECT_STATE.md `## Now` tells Eric which manual items remain

## Tests
Command: `npx vitest run test/e2e/windows.e2e.test.ts`
- capture dimensions equal display size × scaleFactor (1920×1200 on this machine; computed, not hard-coded).
- with the panel open, the captured PNG has no marker-color pixels in the panel's rectangle (content protection works) and is not a black box there.
- a thread survives an app restart with the same data dir (listed, thumbnail served, follow-up works via the owned transcript after the fake projects copy is deleted).
- Clear history (confirm auto-accepted in test mode) removes `threads/` and the fake records a `purge` call for the sessions dir.

## Spec refs
SPEC §2.1, §2.2, §3.4, §5.1, M1.

## Notes
