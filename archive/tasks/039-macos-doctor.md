# 039 · macOS doctor: no Defender text on smoke EPERM; macOS log/config paths

## Objective
The 031 review found two macOS gaps in `doctor`. First, `steps.asrCheck` returns `blocked` for any spawn `EPERM`, and `commands.mjs:203` turns that into "Defender ASR blocks <exe>; ask IT for an exclusion for it" on every platform, so a Mac user gets Windows advice. Second, SKILL.md's doctor section names the log only with a Windows separator (`logs\snapsolve.log`), which 037 turns into `%LOCALAPPDATA%\snapsolve\…` paths. The Mac needs its own wording and paths.

## Scope
In:  `plugin/skills/snapsolve/scripts/commands.mjs` doctor smoke line: the ASR text only on `win32`; on darwin a `blocked` smoke check fails with the `--smoke` EPERM detail and a macOS hint (the app bundle cannot be executed: re-run `/snapsolve install`), never the Defender text. `plugin/skills/snapsolve/SKILL.md` doctor section: on a Mac the log is `~/Library/Application Support/snapsolve/logs/snapsolve.log` and the config is `~/Library/Application Support/snapsolve/config.json` (next to 037's Windows paths). Tests in `test/unit/installer-commands.test.ts` and `test/unit/skill.test.ts`.
Out: changing `asrCheck`'s return shape for win32; making `doctor` print the data folder (037 Out); the Windows paths themselves (037).

## Done when
- [ ] task tests pass; `npx vitest run --project unit` passes; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/installer-commands.test.ts test/unit/skill.test.ts`
- doctor on darwin with a smoke check returning `blocked` → a `fail:` line that names the exe and the EPERM, contains no "Defender" or "ASR", and says to re-run `/snapsolve install`; exit 1.
- doctor on win32 with a smoke check returning `blocked` → still exactly the "Defender ASR blocks <exe>; ask IT for an exclusion for it." line (regression guard).
- doctor on darwin with a smoke check returning `failed` → the generic `--smoke failed:` line, unchanged.
- SKILL.md doctor section names `~/Library/Application Support/snapsolve/logs/snapsolve.log` and `~/Library/Application Support/snapsolve/config.json` for a Mac, and the paths agree with `resolveDataDir("darwin", …)` + `dataPaths` (`logs/snapsolve.log`, `config.json`).
- the existing SKILL.md hygiene test still passes (no `C:\Users`, `/Users/`).

## Spec refs
SPEC §5.1, §8.1; DESIGN §4.2 step 7, §10 risk 6; DECISIONS 020, 024, 031.

## Notes
From the 031 review (2026-10-14), recorded as non-blocking. Depends on 037 because both edit the same SKILL.md doctor paragraph.
