# 073 · ARCHITECTURE module map: app.ts no longer has onAppend (065)

## Objective
ARCHITECTURE.md's module map names `app.ts`'s pipeline entry points as `onCapture`, `onAppend`; 065 removed `onAppend` (a capture now continues the current chat; "+" is `newThread`). Found by 065's reviewer.

## Scope
In:  the `app.ts` line of `## Module map` in ARCHITECTURE.md: `onCapture`, `newThread` instead of `onCapture`, `onAppend`.
Out: any other ARCHITECTURE section; code.

## Done when
- [ ] `grep -c onAppend ARCHITECTURE.md` prints 0
- [ ] `grep -n 'app.ts' ARCHITECTURE.md` shows `onCapture` and `newThread` on the module map line

## Tests
None (no-tests: a one-word documentation fix; no behavior).

## Spec refs
SPEC Amendment 10; DECISIONS 2026-10-18 065 rows.

## Notes
Found in 065's review (pass).
