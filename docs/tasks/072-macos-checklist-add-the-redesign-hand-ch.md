# 072 · macOS checklist: add the redesign hand checks (058–061, 064, 065)

## Objective
Eric runs one current macOS checklist (032). The only copy, `docs/checklists/macos.md` on the parked `keel/032` (a402d20), predates the redesign: it names Ctrl+Option+Q and lacks every hand check the redesign tasks deferred to 032.

## Scope
In:  `docs/checklists/macos.md` on master — the keel/032 items, with each hotkey brought to today's defaults (capture ⌃⌥C, show/hide ⌃⌥X, no append key), plus one row each, with an empty result column, for: 058 drag the window by the title bar, position kept per display; 059 resize from an edge and a corner, minimum 280 × 300, size kept after restart; 060 ⌃⌥X shows and hides, tray Show/Hide names ⌃⌥X; 061 native look (vibrancy blur, light and dark), × hides the window, no Copy button; 064 ⌃⌥C captures; 065 ⌃⌥C twice → both screenshots in one card and the second answer refers to the first, + then ⌃⌥C → a new card, + then a typed question → a new text card, ⌃⌥⇧Q does nothing.
Out: running the checklist (Eric, 032); code changes; voice (063 adds its own rows).

## Done when
- [ ] `grep -c 'Option+Q\|⌃⌥Q' docs/checklists/macos.md` prints 0
- [ ] `grep -n -E '058|059|060|061|064|065' docs/checklists/macos.md` shows a row for each of the six tasks

## Tests
None (no-tests: a manual checklist document for Eric; no behavior to test).

## Spec refs
DESIGN §8; SPEC Amendments 6–10; task files 058–061, 064, 065 (their deferred hand checks).

## Notes
Found while closing 065. When 032 resumes, its branch merges master; take master's `docs/checklists/macos.md`.
