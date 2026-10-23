# 029 · macOS Screen Recording permission state machine

## Objective
SPEC §7.1 / DESIGN §3.2 step 5: on macOS a capture first checks Screen Recording; without the grant it never returns an image and says what the user must do, triggering the system prompt exactly once when the state is undetermined.

## Scope
In:  `src/main/capture.ts`: `CapturerDeps` gains `mediaAccess: { getMediaAccessStatus(kind: "screen"): string }`; before grabbing on darwin: `granted` → capture as today; `not-determined` → one `getSources` call (registers snapsolve, shows the system prompt), image discarded, reject with `SnapsolveError("screenRecordingDenied")` whose detail says the prompt was shown (`prompted: true`); `denied` / `restricted` / anything else → reject `screenRecordingDenied` with `prompted: false`, no `getSources` call. win32 never asks. The panel is not hidden for a capture that will not happen. `test/unit/capture.test.ts`.
Out: the card, its buttons and relaunch (030); main.ts wiring (030).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/capture.test.ts`
- darwin `granted` → normal capture (same result as today), status checked once per capture.
- darwin `not-determined` → `getSources` called exactly once, no image returned, rejects `screenRecordingDenied` with `prompted: true`; the panel was not hidden.
- darwin `denied`, `restricted`, and an unknown string → rejects `screenRecordingDenied` with `prompted: false`; `getSources` never called; panel never hidden.
- win32 → `getMediaAccessStatus` never called.
- A denied capture frees the mutex: the next capture runs (and succeeds once the status is `granted`).
- Existing capture tests stay green unmodified.

## Spec refs
SPEC §2.1, §7.1 (macOS Screen Recording row); DESIGN §3.2 step 5, §7.

## Notes
`systemPreferences.getMediaAccessStatus('screen')` always returns `granted` on Windows; the platform check keeps the call off Windows anyway (ARCHITECTURE: `process.platform` only via the injected `platform`).
