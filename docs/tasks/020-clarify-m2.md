# 020 · Clarify M2 scope

## Objective
Settle the decision DESIGN §10 risk 6 reserves for Eric before M2: whether the Windows packaged app (`@electron/packager` exe) ships unsigned, as SPEC's non-goals say, given that Defender ASR blocks electron.exe on this managed PC; and how M2's Windows install is verified when Electron cannot run here.

## Scope
In:  the answer, recorded as a DECISIONS row (verbatim, `(user, chat)`); a SPEC Amendment only if the answer changes the non-goals (signing); then M2 is planned from SPEC `### M2` + §8.1 + DESIGN §4–5.
Out: any code; requesting an IT exclusion or buying a certificate on our own.

## Done when
- [ ] DECISIONS.md has Eric's answer; 020 unblocked and closed; M2 planned (`tasks.py plan 2`)

## Tests
Command: none — a decision, nothing to test.

## Spec refs
SPEC §8.1, Non-goals (signed distributables), Milestones `### M2`; DESIGN §4, §5, §10 risks 1 and 6.

## Notes
Facts (measured, DESIGN §10 risk 6, task 015): ASR rule 01443614 ("prevalence, age, or trusted list") blocks `node_modules\electron\dist\electron.exe` on this PC in block mode; no admin rights; Eric chose to finish 015 on a Mac rather than ask IT (DECISIONS 2026-10-14).
Inferred, not tested: packager rewrites the exe's resources → new hash with zero prevalence → the same rule blocks the installed `%LOCALAPPDATA%\Programs\snapsolve\snapsolve.exe` on every PC with this policy. A newly issued signing certificate has no reputation either, so signing is not certain to satisfy "trusted list".
Options put to Eric:
- (a) Ship unsigned (SPEC non-goal stands). `doctor` runs the EPERM check and tells managed-PC users the fix is an IT exclusion. M2 tasks are proven by unit/integration tests here (installer steps against a temp dir with fakes); the real Windows install runs on an unmanaged Windows PC (or after an exclusion) as a checklist for Eric. Recommended.
- (b) Add Authenticode signing: SPEC Amendment removing the non-goal for Windows; needs a code-signing certificate (cost, credentials) — outward-facing, Eric's call.
- (c) Defer M2 until M1 is finished on the Mac (015, 009–014), then plan M2 and M3 together.
Also open (resolved during planning, not a question for Eric): DESIGN §10 risk 1, `${CLAUDE_PLUGIN_ROOT}` inside skill execution.
