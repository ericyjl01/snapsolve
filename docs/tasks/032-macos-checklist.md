# 032 · macOS checklist on Eric's Mac

## Objective
M3 done on a real Mac: Eric runs the macOS checklist (DESIGN §8) and the results are recorded.

## Scope
In:  `docs/checklists/macos.md` — every DESIGN §8 macOS item with a result column; follow-up tasks for failures (`tasks.py add`).
Out: code changes (new tasks instead).

## Done when
- [ ] `docs/checklists/macos.md` lists: install; Screen Recording prompt on first capture → grant → Relaunch; menu-bar icon, no Dock icon; Ctrl+Option+Q; capture of the cursor's display; panel over a full-screen app and on other Spaces; panel absent from the PNG (hide path); whether the panel shows in a Teams/Zoom share and a ⌘⇧5 capture (expected: visible in ScreenCaptureKit apps); follow-up; restart persistence; `update` does not re-prompt for Screen Recording; whether macOS 15 shows a monthly re-authorization prompt; a timed-out turn leaves no `claude` process (018)
- [ ] PROJECT_STATE.md `## Now` tells Eric which items remain

## Tests
None (no-tests: manual checklist run by Eric on his Mac; the code is tested in 018 and 028–031).

## Spec refs
SPEC Milestones `### M3`, §9.1; DESIGN §8 (macOS checklist), §10 risks 3–4.

## Notes
Needs 015 (npm test gate restored on the Mac) so e2e runs there too.
