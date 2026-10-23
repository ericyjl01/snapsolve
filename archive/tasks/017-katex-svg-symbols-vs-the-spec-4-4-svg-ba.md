# 017 · KaTeX SVG symbols vs the SPEC §4.4 svg ban

## Objective
Decide whether answers may show KaTeX's SVG-drawn symbols, which SPEC §4.4's `svg` ban currently strips.

## Scope
In:  the decision (DECISIONS row); if svg is allowed, a SPEC Amendment and a follow-up task for `src/renderer/render.ts` + tests.
Out: any other renderer change.

## Done when
- [x] Eric's answer recorded in DECISIONS.md; the follow-up task added if the answer changes render.ts

## Tests
Command: `none (clarify task)`
- none — a decision only; a follow-up task carries the tests

## Spec refs
SPEC §4.4; DESIGN §3.6 (DOMPurify config).

## Notes
Verified in 008 (KaTeX 0.19.0, renderAnswer at d23d031): `\sqrt` draws its radical and vinculum as inline `<svg><path …>`; `\overrightarrow`, `\xrightarrow`, `\widehat`, `\overbrace` draw their stretchy parts the same way. DOMPurify (`USE_PROFILES: {html: true}` + `FORBID_TAGS` incl. `svg`) removes them, so `$\sqrt{2}$` shows a bare "2" and `$\overrightarrow{AB}$` shows "AB" with no arrow.
Options: (a) allow `svg` + `path` only, only with KaTeX's attributes (`xmlns`, `width`, `height`, `viewBox`, `preserveAspectRatio`, `d`), still sanitized by DOMPurify; (b) keep the ban and accept the missing symbols; (c) keep the ban and tell the model (prompts/system.md, task 012) to avoid those commands.
Answer (2026-10-14): option (a) — DECISIONS row, SPEC Amendment 1, follow-up task 019.
