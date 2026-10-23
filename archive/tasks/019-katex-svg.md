# 019 · Render KaTeX's SVG symbols (SPEC Amendment 1)

## Objective
Answers show KaTeX's SVG-drawn symbols (the `\sqrt` radical, stretchy arrows, wide accents, braces, `\vec`) per SPEC Amendment 1, while every other SVG stays out.

## Scope
In:  `src/renderer/render.ts` DOMPurify config — `svg` no longer forbidden; `svg` and `path` added; `viewBox`, `preserveAspectRatio`, `d` added as attributes; KaTeX's geometry attributes kept despite `ALLOWED_URI_REGEXP: /^https?:/` (see Notes); `test/unit/render.test.ts`; DESIGN.md §3.6's DOMPurify line brought in line with the amendment.
Out: any other SVG element (`\cancel`'s `<line>` stays stripped), CSP, markdown-it/KaTeX options, any other renderer change.

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/render.test.ts`
- `$\sqrt{2}$` → a `.katex svg > path` with a non-empty `d`; the `svg` keeps KaTeX's `width`, `height`, `viewBox` and `preserveAspectRatio` values (fails while the URI rule strips them).
- `\overrightarrow{AB}`, `\xrightarrow{f}`, `\widehat{xyz}`, `\overbrace{abc}`, `\vec{v}` each keep an `svg` with a `path`.
- Across a sample of every SVG-drawing command: only `svg` and `path` elements in the SVG namespace, and only the attributes `xmlns, width, height, viewBox, preserveAspectRatio, style` (svg) and `d` (path).
- The sanitizer applied to hand-written hostile SVG (`onload`/`onclick`, `<script>`, `<use href>`, `<foreignObject>`, `<animate>`/`<set>`, `<image href>`, `<a href="javascript:…">`, `<style>`) keeps no event handler, no `javascript:`, no `use`/`foreignObject`/`animate`/`set`/`image`/`script`/`style` (needs the sanitizer reachable from the test — e.g. export a `sanitize(html)` that `renderAnswer` uses).
- `\cancel{x}` renders `x` without throwing and without a `line` element (the amendment's limit).
- Unchanged, existing tests stay green unmodified: raw `<svg onload>` in Markdown stays text; `img`, `math`, `iframe`, `form`, `input`, `style` stripped; only http(s) hrefs survive.

## Spec refs
SPEC §4.4, Amendment 1; DESIGN §3.6.

## Notes
Measured in 017 (KaTeX 0.19.0, DOMPurify 3.4.17, jsdom): KaTeX's SVG uses only `svg` (xmlns, width, height, viewBox, preserveAspectRatio; `\vec` adds `style`), `path` (d) and, for `\cancel`/`\bcancel`/`\xcancel`, `line` (x1, y1, x2, y2, stroke-width).
With `ALLOWED_URI_REGEXP: /^https?:/`, DOMPurify drops every attribute value that is not URI-safe and does not match the regexp — so `ADD_TAGS: ["svg","path"]` + `ADD_ATTR: ["viewBox","preserveAspectRatio","d"]` alone leaves bare `<svg xmlns>` and `<path>`. Adding `ADD_URI_SAFE_ATTR: ["width","height","viewBox","preserveAspectRatio","d"]` keeps them. With that config, hostile SVG came out as `<svg width="1em"><path d="M0 0"></path><a>t</a></svg>` (an inert `<a>` without href; text kept).
