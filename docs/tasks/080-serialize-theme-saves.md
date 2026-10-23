# 080 · serialize theme saves: two quick Appearance picks can save out of order

## Objective
Review note on 077: `applyTheme` saves without waiting for an earlier save, so picking Light then Dark quickly runs two `saveTheme` calls at once and the older one can finish last, leaving config.json with the wrong theme for the next start.

## Scope
In: saves from `applyTheme` run one at a time in call order (a promise chain), or a pending save is replaced by the newest choice; the live theme is unaffected.
Out: anything else about the Appearance menu.

## Done when
- [ ] `npx vitest run test/unit/app.test.ts` passes
- [ ] `npm test` is green

## Tests
- app unit: two `applyTheme` calls whose first save resolves after the second → the saves run in order (the second starts only after the first finishes, or the first is skipped), and the last value saved is the second theme
- app unit: a failing first save does not stop the second

## Spec refs
SPEC Amendment 14; task 077.
