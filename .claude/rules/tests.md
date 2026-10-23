---
paths:
  - "test/**"
---
# Tests (vitest)
- The suite's git-clean teardown (test/git-clean-setup.ts) fails the run if anything new shows in `git status`, including a tracked file that was clean at the start and edited while the run is going: finish memory-file edits before starting `npm test`, `red` or `close`, and clean up anything a test writes (issues.md 2026-10-13 task 002, 2026-10-14 task 006, 2026-10-23 task 088).
- Fakes must settle on a later turn and record when they finish, so a step that does not wait shows up in the order (2026-10-14, 007); keep new records out of lists other tests compare exactly (2026-10-14, 029).
- Assert whole values (lines, words, exact objects), not substrings, and assert bytes on disk, not just return values (2026-10-14, tasks 003 and 025).
- The unit tests' fake runner writes no turns: disk state alone cannot tell a fresh chat from one the fake has run (2026-10-23, 088).
- Inserting TypeScript through a Python heredoc: use raw strings or the Edit tool, and check every file in the red output actually ran (2026-10-15, 044).
