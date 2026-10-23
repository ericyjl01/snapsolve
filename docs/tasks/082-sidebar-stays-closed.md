# 082 · sidebar stays closed after the user closes it, across window resizes

## Objective
Eric (0.2.4): "if I collapse these sidebar and then I resize the window, the sidebar comes out. If I close the sidebar, it should stay closed until I click it again to open." Cause: `src/renderer/renderer.ts:485` re-opens the sidebar whenever the window crosses 600 px wide (`wide` change → `setSidebar(wide.matches)`), discarding the user's choice.

## Scope
In:
- Once the user closes the sidebar (its Hide chats toggle, the scrim, or choosing a chat / New chat in the narrow overlay), it stays closed through any resize, in either direction across 600 px, until the user opens it (Show chats).
- Once the user opens it (or while it is open by default), narrowing below 600 px closes the overlay (an overlay must not cover the chat by itself) but does not count as the user closing it, so widening again docks it open.
- Before the user has touched it: today's defaults (narrow → closed; crossing to ≥ 600 px → docked open; back below → closed).
- SPEC Amendment 16 (refines Amendment 15's "starts open/closed"); DECISIONS row.
Out: remembering the state across restarts (Amendment 15 Out stays).

## Done when
- [ ] `npx vitest run test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e: at 760 px, Hide chats, then resize to 700 px, 360 px and back to 760 px → the sidebar is hidden at every step; Show chats opens it docked

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- e2e: wide, user closes → resize within wide (760 → 700) stays closed
- e2e: wide, user closes → narrow (360) → wide (760) stays closed; Show chats then docks it open
- e2e: narrow, user opens then closes via the scrim → widen to 760 stays closed
- e2e: wide, open (default) → narrow closes the overlay → wide again docks it open (the user never closed it)
- e2e: narrow, user opens (Show chats) → widen to 760 → docked open, no scrim
- 078's "docked open at 760 px, collapses, closed overlay at 360 px" case still passes unchanged

## Spec refs
SPEC Amendments 15, 16; task 078.

## Notes
Eric 2026-10-23 (chat), quoted in Objective.
