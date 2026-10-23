# 081 · composer screen-reader label follows its placeholder

## Objective
Review note on 079: the composer's visually hidden `<label for="follow-up">` always says "Ask a follow-up", while the placeholder says "Ask anything" when no chat is on screen, so a screen reader hears the wrong prompt.

## Scope
In: the label's text (or the textarea's `aria-label`) follows the placeholder in `updateComposer`.
Out: other accessibility work.

## Done when
- [ ] `npx vitest run test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green

## Tests
- e2e: the textarea's accessible name (`getByRole("textbox")` name) is "Ask anything" with no chat on screen and after New chat, "Ask a follow-up" with one

## Spec refs
SPEC Amendment 15; task 079.
