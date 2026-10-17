# 006 · Runner: spawn, queueing, timeouts, resume

## Objective
Run Claude turns per SPEC §3.1–3.5 with deterministic tests against a fake `claude`.

## Scope
In:  `src/main/runner.ts` `createRunner({ command: {path, prefixArgs}, store, config, systemPrompt, env, spawn, now, log, loadSendImage })` with pure `buildArgs(turn)`, `buildEnv(env, allowApiKey)`, `buildUserMessage(kind, images, text)`; `enqueue(threadId, turn)` emitting `delta / thinking / init / rateLimit / status / done / error`; per-thread FIFO; global cap; timeout kill; transcript adoption after a first turn; resume-failure fallback. `test/fixtures/fake-claude.mjs` (scenarios via `FAKE_CLAUDE_SCENARIO`: ok, slow, hang, crash, no-conversation, not-logged-in, api-key, rate-limited; writes transcripts like claude: `--session-id` → `$FAKE_PROJECTS/<enc>/<sid>.jsonl`, `--resume <path>` → appends there; logs argv/env/stdin/start/end to `$FAKE_LOG`).
Out: capture, UI, auth status command (011).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/runner.test.ts test/integration/runner.integration.test.ts`
- unit buildArgs first turn: exact SPEC §3.1 flag list, `--session-id <uuid>`, no `--resume`; system prompt passed as one argv element.
- unit buildArgs later turn: `--resume <absolute transcript path>`, no `--session-id`; never `--bare`, `--setting-sources`, `--system-prompt-file`.
- unit buildEnv: strips `CLAUDECODE`, `CLAUDECODE_*`, `CLAUDE_CODE_ENTRYPOINT`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; keeps the API vars when `allowApiKey`; keeps PATH.
- unit buildUserMessage: new = image then "Solve the problem on this screen."; follow-up = text only; append = image then "Here is the next part."; media type preserved.
- unit spawn options: `windowsHide: true`, cwd = sessions dir, dir created before spawn.
- integration ok: deltas in order, done carries result fields, transcript moved into the thread dir and removed from the fake projects dir.
- integration follow-up resumes by absolute path; fake appends to that file.
- integration per-thread FIFO: turn 2 starts after turn 1 exits (fake log timestamps).
- integration cap 2: third thread waits with status `queued`, starts after one finishes.
- integration hang + small timeoutSec: process killed, turn errored with retry flag, no orphan.
- integration no-conversation: fallback fresh session carrying prior images + "Earlier answers in this thread:"; new sid stored; card note flag set.
- integration missing claudePath → error kind `claudeNotFound`, runner keeps working.
- integration crash mid-stream (exit 1, no result) → errored turn, retry flag.

## Spec refs
SPEC §3.1, §3.2, §3.4, §3.5.

## Notes
On Windows `.cmd` shims cannot be spawned without a shell; tests run the fake as `process.execPath` + `prefixArgs`.
