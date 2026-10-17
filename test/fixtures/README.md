# Test fixtures

- `stream/` — recorded `claude -p --output-format stream-json` sessions (task 005)
- `problems/` — problem screenshots and `expected.json` for live tests (task 012)
- `fake-claude.mjs` — scriptable stand-in for the `claude` CLI (task 006)

Fixtures never contain real screenshots of a user's screen, emails or org identifiers.

## stream/ — how the recordings were made

Recorded once on 2026-10-14 with Claude Code 2.1.299 on Windows, logged in with a claude.ai plan (no API key), using the
exact SPEC §3.1 flags (`-p --safe-mode --strict-mcp-config --tools "" --input-format stream-json --output-format
stream-json --verbose --include-partial-messages --model <m> --effort <e> --system-prompt <short prompt>`) plus
`--session-id <uuid>`, with every `CLAUDE*` variable removed from the environment and one stream-json user message on stdin:

| File | Model / effort | Input |
|---|---|---|
| `text-sonnet-low.jsonl` | sonnet / low | text "What is 17 × 3? Answer in one line." |
| `image-sonnet-low.jsonl` | sonnet / low | a generated 480×120 PNG "Solve for x: 2x + 3 = 11" + "Solve the problem on this screen." |
| `thinking-opus-high.jsonl` | opus / high | a two-train catch-up word problem (text) |
| `resume-missing.jsonl` | sonnet / low | `--resume 00000000-0000-4000-8000-000000000000` (no such session; exit 1) |

Scrubbed after recording, in the `system/init` line only: `cwd`, `messaging_socket_path`, `output_style`, `plugins`,
`skills`, `slash_commands` and `terminal_slash_commands` (they described the recording machine's home folder and local
setup). Every other line is byte-for-byte what `claude` printed. The recordings' transcripts were deleted from
`~/.claude/projects`.

## problems/ — live-test screenshots

Drawn by `scripts/make-problem-fixtures.ps1` (System.Drawing, Windows): 1280×800 PNGs that look like a screen with one
problem on it — `algebra`, `rates`, `code-bug` (an editor with a Python off-by-one and its terminal output) and
`multiple-choice`. `expected.json` holds, per file, the accepted answer as a regex that must match the answer's first
non-empty line, and for `code-bug` the fenced fix it must show. Used only by `test/live/solve.live.test.ts`.
