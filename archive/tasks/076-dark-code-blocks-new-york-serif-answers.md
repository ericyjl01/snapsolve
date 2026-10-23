# 076 · dark code blocks, New York serif answers, terminal-style see-through window

## Objective
After 0.2.1 Eric found the dark panel hard to read and not see-through: code blocks are still white (highlight.js's light `github` theme is the only one loaded), answers use the 13 px system sans while the Claude app uses a serif, and the frosted vibrancy layer makes the window look solid. He wants code on black like the Claude app, a Claude-like serif, and a window "marginally see-through, similar to how a terminal would be".

## Scope
In:
- Code blocks: dark theme → highlight.js `github-dark` on a near-black block (Claude-app-like); light theme keeps `github`. Both theme files ship in the renderer assets; the dark one applies only under `prefers-color-scheme: dark`.
- Fonts: answer text (and the question bubbles) in Apple's New York serif via `ui-serif` (fallbacks `"New York"`, Georgia, serif) at 14 px; code and inline code in Menlo (`ui-monospace`, Menlo, monospace) at 12.5 px; the title bar, buttons and status lines stay the system sans.
- See-through: macOS window loses `vibrancy`/`visualEffectState` (stays transparent, `backgroundColor` `#00000000`); `--ground` becomes a near-solid color: dark `rgba(24, 24, 24, 0.88)`, light `rgba(246, 246, 248, 0.88)`; cards/rows/fields adjusted so they read on it.
- SPEC Amendment 13 (supersedes Amendment 12's ground values and Amendment 9's vibrancy); DECISIONS rows; 061/075 tests that assert vibrancy or the old ground values are updated to the new spec in the tests commit.
Out: the Anthropic fonts themselves (Eric chose the macOS lookalike); a code-block language label; a translucency setting; Windows.

## Done when
- [ ] `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] in the dark theme, a rendered python block's computed background is near-black and its keyword color is not github-light's; in the light theme the block stays light (e2e)

## Tests
Command: `npx vitest run test/unit/panel.test.ts test/e2e/panel.e2e.test.ts`
- panel unit: on macOS the window has no `vibrancy` and no `visualEffectState`, `transparent`-capable `backgroundColor` `#00000000` (replaces the 061 vibrancy test); off macOS unchanged
- e2e theme cases (075's, updated): ground `rgba(24, 24, 24, 0.88)` dark / `rgba(246, 246, 248, 0.88)` light
- e2e: an answer with a ```python block: dark → `pre code.hljs` background luminance < 0.1 and a keyword span's color differs from github light's `#d73a49`; light → background luminance > 0.9
- e2e: `.answer` computed font-family starts with `ui-serif` and its font-size is 14px; `.answer pre code` font-family starts with `ui-monospace` and includes Menlo; the title bar keeps the system font (`-apple-system`)

## Spec refs
SPEC §4.2, Amendments 9 and 12; tasks 061, 075.

## Notes
Eric 2026-10-22 (chat, with screenshots of the Claude app's code block): font "Mac's serif lookalike"; see-through "Like a terminal, no blur (Recommended)".
