# 061 · panel restyle: native macOS look (mockup A2), remove the Copy button

## Objective
Eric (2026-10-17): picked direction A ("Native macOS") from the canvas https://claude.ai/artifact/YDwUWu2mMWHJui9b5unfPH and wants the Copy button gone ("not needed"). He does not want the answer re-formatted: the answer stays the model's own Markdown, rendered as today.

## Scope
In:
- `src/renderer/styles.css` + markup in `renderer.ts`, following artboard "A2": frosted background (Electron `vibrancy` on macOS, or a translucent CSS fallback), system font, 36 px title bar with the app mark, "snapsolve", a × (hide) button (and the mic button once 063 lands); compact cards (thumbnail + title + time); follow-up composer pinned at the bottom of the window for the newest thread; Retry shown only on error; older threads as one-line rows; light and dark.
- Remove Copy: the button, its handler, `api.copy` from the preload and its IPC handler; update the preload-name list (SPEC §4.4 / Amendment 2 count) with a DECISIONS row.
- The × button needs a renderer → main call (Amendment 3 avoided one): add one preload function (e.g. `hide`) and record it.
Out: answer formatting (unchanged Markdown/KaTeX/highlight.js); window move/resize (058/059); hotkeys (060); new dependencies.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/unit/render.test.ts test/e2e/panel.e2e.test.ts` exits 0
- [ ] `npm test` exits 0
- [ ] On the Mac, side by side with the A2 artboard: same structure and feel, no Copy button, readable in light and dark

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/unit/render.test.ts test/e2e/panel.e2e.test.ts`
- e2e "no Copy button and no api.copy" — proves the button is gone and the preload exposes the new exact name list
- e2e "× hides the window" — proves the new preload call hides it
- e2e "composer at the bottom sends a follow-up to the newest thread" — proves Enter sends, Shift+Enter is a new line, as today
- e2e "Retry appears only on an errored turn"
- e2e "answer Markdown renders unchanged" — proves KaTeX/code still render (existing assertions keep passing)

## Spec refs
SPEC §4.2, §4.4, Amendment 2, Amendment 3; DESIGN panel section; `src/renderer/*`, `src/preload/*`.

## Notes
Set the test command with `tasks.py set 061 --test-cmd` if render.test.ts is not touched.
