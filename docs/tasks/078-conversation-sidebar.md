# 078 · conversation sidebar: collapsible chat list, one chat on screen

## Objective
Eric wants the industry-standard chat layout (Claude, ChatGPT): a collapsible list of conversations on the left and one conversation on screen. Today every thread is stacked in the window (the newest open, older ones as "Earlier" rows). Approved mockup: https://claude.ai/artifact/RJd7MeYL52hZh2ry3aAJpe (frames "Narrow · sidebar closed", "Narrow · sidebar open (overlay)", "Wide window · sidebar docked").

## Scope
In:
- Main area shows exactly one thread (the "current" one): its turns as today (thumbnail, question bubble, answer, status line, Retry). No "Earlier" rows, no collapsed cards.
- Title bar: a sidebar toggle button (aria-label "Show chats" / "Hide chats", the rectangle-with-divider icon) at the far left, then "snapsolve", then the voice, new chat (+) and hide (×) buttons as today.
- Sidebar (`nav` aria-label "Chats"): a header row with the toggle and "Chats", a "New chat" row (does what + does), then every thread newest first, grouped "Today", "Yesterday", "Previous 7 days", "Older" (empty groups omitted), each row the thread's title (titleOf), one line with ellipsis, the current thread highlighted (`aria-current="true"`). Busy threads show a small spinner/dot; errored ones a red dot.
- Narrow window (< 600 px wide): the sidebar overlays the chat (about 248 px wide) with a dimmed scrim behind it; clicking the scrim, pressing the toggle, choosing a chat or New chat closes it. Starts closed.
- Wide window (≥ 600 px): the sidebar is docked beside the chat (about 232 px) and starts open; the toggle collapses/expands it; the chat column and composer are centred with a max width of ~560 px; the title bar over the chat shows the current thread's title.
- Choosing a thread makes it current: it is shown, the composer follows it up, and the next capture continues it (main must know: a new preload function `openThread(threadId)` → IPC `thread:open`, main sets its current thread exactly as a capture into that thread would; preload grows to sixteen). New chat / + keeps today's behavior (065): the main area shows an empty state ("Press the snapsolve hotkey…" / composer "Ask anything") and the next capture or typed question starts a thread.
- A new capture or a new thread from elsewhere becomes current and is shown (as today the newest is on screen); a turn finishing in a non-current thread only updates its sidebar row.
- The permission cards (Screen Recording, voice) show in the main area as the current thread.
- Theme: both themes, colors from styles.css tokens (add `--sidebar`, `--scrim`, `--selected`).
- SPEC Amendment 15 (one chat on screen + sidebar; preload sixteen); DECISIONS rows; tests from 051/057/061/065 that assert "Earlier" rows, collapsed cards or several cards on screen are updated to the new layout in the tests commit (same behavior, new place: e.g. "older threads open on click" becomes "choosing a chat in the sidebar shows it").
Out: renaming, deleting or searching chats; pinning; remembering the sidebar's open/closed state across restarts; thumbnails in the sidebar; the composer's new look (079).

## Done when
- [ ] `npx vitest run test/unit/app.test.ts test/unit/ipc.test.ts test/e2e/panel.e2e.test.ts` passes
- [ ] `npm test` is green
- [ ] e2e at the default 360 px: two captures in separate chats → only one thread's turns in the main area; the toggle opens the overlay listing both newest first under "Today"; choosing the older one shows it, closes the overlay, and a typed follow-up and the next capture both land in it

## Tests
Command: `npx vitest run test/unit/app.test.ts test/unit/ipc.test.ts test/e2e/panel.e2e.test.ts`
- app unit: `openThread(id)` makes `id` the thread the next capture appends to (and clears a pending "+"); an unknown id is rejected with no change; a capture after `openThread` of an errored or full thread follows the same rules as today (051's continued-thread split)
- ipc unit: `thread:open` is in the channel list with its argument validated (string id; anything else rejected)
- e2e: exactly sixteen preload functions, `openThread` among them (updates 174's fifteen)
- e2e: narrow layout — one thread on screen; the toggle (aria-label "Show chats") opens `nav[aria-label=Chats]` over a scrim; rows newest first with group headings; scrim click closes; current row has `aria-current="true"`
- e2e: choosing a row shows that thread, closes the overlay, the composer's follow-up goes to it, and the next capture continues it (thread.json gains the turn)
- e2e: New chat in the sidebar empties the main area and the next typed question starts a new thread that becomes current and listed first
- e2e: resizing the window to 760 px wide docks the sidebar open beside the chat (no scrim, chat still visible); the toggle collapses it; back at 360 px it is an overlay and closed
- e2e: a turn finishing in a non-current thread does not change the main area
- e2e: grouping — threads dated today, yesterday, 3 days and 20 days ago (fixtures with set `createdAt`) land under Today, Yesterday, Previous 7 days, Older
- e2e: the dark and light themes give the sidebar a different background from the chat (computed colors differ)

## Spec refs
SPEC §4.1–4.4, Amendments 3, 9, 11, 13; tasks 051, 057, 061, 065.

## Notes
Eric 2026-10-22 (chat): "I want there to be a collapsible sidebar menu like traditional chat AI interfaces like Claude chat . ChatGPT … a menu on the left where you can open and collapse and have your conversations there." Choice: "Overlay when narrow (Recommended)". Mockup approved: "Looks great. queue the work".
