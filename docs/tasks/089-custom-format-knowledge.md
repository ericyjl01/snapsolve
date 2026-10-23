# 089 · your own answer format and knowledge base (editable prompt + knowledge files)

## Objective
Eric (2026-10-23, chat): "is there a way I could kind of fine-tune this model as in adjust its output to a specific format and give it a knowledge base that it can act on and draw from." Then: "note this down. will touch back on it later." Parked until Eric returns with the answers under Open questions; not ready to start.

What was said (no fine-tuning on this setup: snapsolve runs `claude -p` on Eric's claude.ai login; steering is by instructions and supplied material):
- **Format:** every answer follows `prompts/system.md` (~200 words, built into the app; a change needs a release). Make the format part editable without a release; one example of the wanted format works better than a description.
- **Knowledge base, option (a), recommended first:** a knowledge file (or folder of text/markdown) in `~/Library/Application Support/snapsolve/`, attached to the system prompt on every question. Fine up to a few hundred pages; costs a little first-word latency and more of the 5h/7d usage per answer.
- **Knowledge base, option (b), only if (a) is outgrown:** let claude read-only search one folder (today `--tools ""` and `--safe-mode`, so a screenshot can't make it act; read-only on one folder is a contained change). Slower answers. Needs Eric's approval (it changes SPEC §3.1's no-tools rule).

## Scope
In (option a, once the questions are answered):
- Two user-editable files in the data folder, e.g. `format.md` (replaces or extends the format part of the system prompt) and `knowledge.md` / `knowledge/` (appended as reference material, clearly marked as reference, not instructions); read at startup (or per turn); missing files → today's behaviour.
- A size cap with a clear warning when the knowledge is too large; doctor reports the files and their size.
- SPEC amendment; DECISIONS row.
Out: fine-tuning; option (b) unless Eric approves it; PDFs/scans unless the answers say so (they would need conversion to text first).

## Open questions (for Eric)
1. What goes in the knowledge base: what material, roughly how much, and in what form (typed notes, PDFs, textbook scans)?
2. What answer format do you want? An example answer if you have one.

## Done when
- [ ] (to be written when the questions are answered)

## Tests
Command: `npx vitest run test/unit/config.test.ts test/e2e/panel.e2e.test.ts`
- (to be written when the questions are answered: files present/missing/too large, the system prompt the runner passes, doctor output)

## Spec refs
SPEC §3.1 (system prompt, tools off), §6.1 (data folder).

## Notes
Eric 2026-10-23 (chat), quoted in Objective.
