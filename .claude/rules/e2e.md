---
paths:
  - "test/e2e/**"
  - "test/fixtures/fake-claude.mjs"
---
# e2e (Electron via playwright-core)
- Keys that main handles (Esc's before-input-event) go through `webContents.sendInputEvent` from `app.evaluate`; Playwright's keyboard (CDP) skips them. Use it only for keys the renderer handles (issues.md 2026-10-17, task 009).
- `launchApp` passes `colorScheme: null`, or Playwright emulates light and overrides the app's theme (2026-10-22, 075).
- `.answer` also matches the streaming node: wait for `.answer:not(.streaming)` when the saved answer matters; a card shows only what a runner event or listThreads delivered (2026-10-17, 057).
- A capture shows the window at its saved size and `setBounds` never emits `resized`: re-apply a width after capturing before measuring layout (2026-10-23, 084).
- An element hidden with the `hidden` attribute needs its own `[hidden] { display: none }` when its class sets `display` (2026-10-18, 065).
- Timeouts under load (2026-10-17, 059 and 064): re-run the e2e file alone before treating a timeout as real.
