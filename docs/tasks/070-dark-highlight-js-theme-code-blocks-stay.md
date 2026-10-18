# 070 · dark highlight.js theme: code blocks stay white (github light) in dark mode

## Objective
Found in 061: `scripts/renderer-assets.mjs` copies only highlight.js's `github.min.css` as `hljs-theme.css`, which paints `.hljs` `#fff` with dark token colors, so in dark mode every code block is a white slab in the frosted window (readable, but off the A2 look). Ship the matching dark theme for dark mode.

## Scope
In:  `scripts/renderer-assets.mjs` also copies `github-dark.min.css` (e.g. `hljs-theme-dark.css`); `index.html` links each with a `media="(prefers-color-scheme: light|dark)"` attribute (CSP `style-src 'self'` already allows it); the release's renderer asset list if it names files.
Out: changing highlight.js languages or render.ts; new dependencies (highlight.js already ships the theme).

## Done when
- [ ] `npx vitest run test/unit/renderer-assets.test.ts test/e2e/panel.e2e.test.ts` exits 0 (adjust to the real test file names)
- [ ] `npm test` exits 0
- [ ] In dark mode a code block's `.hljs` background is dark and its text readable

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- e2e "code blocks follow the color scheme" — with `emulateMedia({ colorScheme: "dark" })`, `getComputedStyle(.answer pre code.hljs).backgroundColor` is not white; with "light" it is the light theme's
- unit (assets) — both theme files are copied into `dist/renderer/`; a missing theme file fails the build with its name

## Spec refs
SPEC §4.4 (rendering), Amendment 9; `scripts/renderer-assets.mjs`, `src/renderer/index.html`.

## Notes
061's styles.css frames the block (`.answer pre`) and leaves its fill to highlight.js.
