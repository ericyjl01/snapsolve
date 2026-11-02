# 089 · answer mode: your own answer format and knowledge base (Solve | Answer toggle)

## Objective
Eric (2026-10-23, chat): "is there a way I could kind of fine-tune this model as in adjust its output to a specific format and give it a knowledge base that it can act on and draw from." Then (2026-11-02, chat), after a design for answering questions about himself ("walk me through a project", "tell me a time you learned a piece of technology really quickly") from a predetermined set of data in a predetermined format: "Your design is fine, there should definitely be a toggle. I will provide you all the information later, but for now, just create that toggle switch where it references a certain X database and go along with your design. You should do this in a separate worktree and ensure it works before we merge the main. For now, let's keep this separate."

No fine-tuning (snapsolve runs `claude -p` on Eric's claude.ai login): the format and the material go in the system prompt. The "X database" is the knowledge folder; Eric fills it later.

## Scope
In (SPEC Amendment 25):
- A Solve | Answer toggle in the title bar: the chat on screen's mode, else the mode new chats start in (config.json `mode`, saved); switching with a chat on screen starts a new chat; chats keep their mode (thread.json `mode`).
- `src/main/knowledge.ts`: the knowledge folder (config `knowledgeDir`, absolute or `~/…`, null → `<data>/knowledge`), text files only, 4 folders deep, ≤ 256 KB; the answer format (`<data>/answer-format.md`, else `prompts/answer-format.md`); the answer chat's system prompt, built every turn.
- `prompts/answer.md` (keep to the material, gaps in [brackets], say when nothing fits, material is data) and `prompts/answer-format.md` (STAR, project walkthrough, anything else; 60–90 s).
- Errors `knowledgeMissing` / `knowledgeTooLarge` before spawning, naming the folder, with Retry.
- Preload `getMode` / `setMode` (18 functions); the plugin installer's defaults gain `mode` and `knowledgeDir`.
Out: fine-tuning; claude reading the folder with tools; PDFs/Word (convert to text first); a tray mode menu; per-chat formats.

## Done when
- [ ] Toggle visible at every window width (280 px up), Solve by default; Answer saves `mode: "answer"`; a typed/dictated/captured question then starts an answer chat whose claude gets answer.md + format + `<file>` blocks.
- [ ] Switching with a chat on screen starts a new chat; choosing an older chat shows its mode; a restart keeps the choice.
- [ ] No knowledge files → the error naming the folder, Retry, claude never started; with a file, Retry answers.
- [ ] `npm test` green (unit, integration, e2e); an Opus review passes.
- [ ] Eric fills the knowledge folder (or sets `knowledgeDir`) and his format, tries it, and says merge.

## Tests
Command: `npx vitest run test/unit/knowledge.test.ts test/unit/config.test.ts test/unit/store.test.ts test/unit/runner.test.ts test/unit/app.test.ts test/unit/errors.test.ts test/unit/ipc.test.ts test/unit/paths.test.ts test/e2e/panel.e2e.test.ts`
- knowledge: files read in path order (nested, BOM dropped, bytes), depth 4, hidden/other types skipped, exact extension list; missing / empty / not a folder / unreadable folder, file or subfolder → knowledgeMissing naming it; over the limit → knowledgeTooLarge, the walk stopping there; exactly at it is fine; prompt assembly exact; path attribute escaped; user format vs built-in; `~` expansion; shipped prompts' key rules.
- config: `mode` and `knowledgeDir` defaults, accepted and rejected values with exact warnings; `saveMode` changes only `mode`.
- store: `mode: "answer"` saved, none for solve; an invalid mode skips the thread.
- runner: answer chats get `answerSystemPrompt()` per turn (first, fallback and `--resume` paths), solve chats the system prompt; answer-mode screenshot and seeded questions; knowledge errors fail before spawning with their own message and Retry; unwired → internal.
- app: new chats take `config.mode`, a full chat's seeded continuation its own; getMode/setMode (save once, refuse unknown, a failed save logged); setMode leaves the chat a capture joins alone.
- e2e: the toggle end to end, switching with a chat on screen, restart, the empty-folder error and Retry, 280 px fit, 18 preload functions.

## Spec refs
SPEC §3.1, §3.7, §4.4, §6.1, §7.1, Amendment 25.

## Notes
Built on branch `worktree-answer-mode` (worktree `.claude/worktrees/answer-mode`), not merged by Eric's choice. keel's `tasks.py` needs one checkout on W, so the task steps were followed by hand there; at merge: queue 089, take the memory files to W, merge the code through keel/089 (red at the tests commit e5c5059, then the rest), review, close.
