# 008 · Answer rendering pipeline

## Objective
SPEC §4.4: Markdown + math + code → sanitized HTML, safe against content injected via the screen.

## Scope
In:  `src/renderer/render.ts` `renderAnswer(markdown): string` using markdown-it (`html:false, linkify:false`), `@vscode/markdown-it-katex` + katex (`output:'html', trust:false, throwOnError:false, maxExpand:1000, maxSize:50`), highlight.js (known languages only), DOMPurify (forbid `img, svg, math, iframe, form, input, style`; URIs `^https?:` only); deps added; `scripts/build.mjs` copies KaTeX CSS + fonts and highlight.js theme into `dist/renderer/`.
Out: panel UI (009).

## Done when
- [ ] task tests pass; `npm run build` exits 0 and `dist/renderer/` contains the KaTeX CSS and fonts

## Tests
Command: `npx vitest run test/unit/render.test.ts`
- inline `$x^2$` and block `$$\frac{a}{b}$$` → `.katex` elements, no `<math>`.
- fenced `python` block → highlight.js classes; unknown language → escaped plain code, no throw.
- `![x](https://evil.example/?q=secret)` → no `<img>` and no `evil.example` src.
- raw `<script>alert(1)</script>` → escaped text, no script element.
- `[x](javascript:alert(1))` → no `javascript:` href; `[ok](https://example.com)` → https anchor kept.
- TeX `\href{javascript:…}{x}` and `\url{…}` → not rendered as links (trust false).
- macro bomb (`\def\a{\a\a}\a`) → returns within 1 s with error styling, no throw.
- `\rule{1000em}{1000em}` → size capped.
- partial streaming input (unclosed `$$`, unclosed fence) → renders without throwing.

## Spec refs
SPEC §4.4.

## Notes
Tests run in vitest's `jsdom` environment.
