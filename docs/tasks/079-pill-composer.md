# 079 · pill composer: ChatGPT-style rounded text bar

## Objective
Eric wants the text bar adapted to the chat-app layout, ChatGPT-style. Approved mockup: https://claude.ai/artifact/RJd7MeYL52hZh2ry3aAJpe (the rounded bar at the bottom of every frame).

## Scope
In:
- The composer box becomes a pill: border-radius half its single-line height (about 20 px at 40 px tall), a hairline border, `--field` background with a soft shadow, inner padding so the buttons sit inside the rounded ends; no top border line on the composer strip.
- Order inside: mic button (left, 30 px round, muted icon), the textarea (14 px system sans, placeholder "Ask anything" with no current thread and "Ask a follow-up" with one), the send button (right, 30 px round: `--fg` background with `--ground`-colored arrow; disabled-looking when the box is empty).
- Grows with its text as today (up to about five lines); when taller than one line the radius stays ~20 px and the buttons stay aligned to the bottom.
- In the wide (docked) layout the bar is centred under the chat column with the same max width (078).
- The listening bar (063) takes the same pill shape.
- Both themes.
Out: attachments, model picker or other new buttons; changing what Enter/Shift+Enter do.

## Done when
- [ ] `npx vitest run test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e: the composer box's computed border-radius ≥ 18 px; the mic button is left of the textarea and the send button right of it (bounding boxes); send is round (border-radius ≥ half its width)

## Tests
Command: `npx vitest run test/e2e/panel.e2e.test.ts`
- e2e: `#composer-box` border-radius ≥ 18 px; the box has no square corners in either theme
- e2e: `#composer-voice` box's right edge ≤ the textarea's left edge; `#send`'s left edge ≥ the textarea's right edge; all three inside the box
- e2e: `#send` border-radius ≥ width / 2; with an empty box it has the disabled look (opacity < 1) and typing makes it opaque
- e2e: placeholder "Ask anything" with no thread / after New chat, "Ask a follow-up" with a current thread
- e2e: typing five lines grows the box; the buttons' bottoms stay aligned with the box's bottom padding
- e2e: the listening bar (voice hotkey) has the same border-radius as the composer box
- e2e: in the 760 px wide layout the box is horizontally centred under the chat column (left and right gaps equal within 2 px)

## Spec refs
SPEC §4.2, Amendment 15; tasks 061, 063, 078.

## Notes
Eric 2026-10-22 (chat): "That includes the text bar where we enter our information. Adapt it." Choice: "ChatGPT-style pill". Mockup approved: "Looks great. queue the work".
