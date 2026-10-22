# 074 · update re-packages snapsolve.app when its Info.plist keys change

## Objective
`/snapsolve update` 0.1.0 → 0.2.0 kept the 0.1.0 snapsolve.app (same Electron version), so its Info.plist lacks NSSpeechRecognitionUsageDescription and the voice helper is killed by TCC with SIGABRT on every ⌃⌥V (crash report: "The app's Info.plist must contain an NSSpeechRecognitionUsageDescription key"). The user sees "Voice input stopped working."

## Scope
In:  the installer's update step on macOS re-packages (and re-signs) snapsolve.app when the Info.plist keys `extendInfo` adds are missing or differ from the installed bundle's, not only when the Electron version changes; the existing `warn:` about the Screen Recording re-grant is printed in that case too.
Out: Windows; changing which keys `extendInfo` adds.

## Done when
- [ ] the installer-steps tests for this pass; an update from a bundle without the 063 usage strings re-packages it and prints the re-sign warning

## Tests
Command: `{{TEST_CMD}}`
- update with the same Electron version but an installed Info.plist missing NSSpeechRecognitionUsageDescription → re-packages, warn line printed
- update with the same Electron version and all extendInfo keys present and equal → no re-package, no warn
- update with a changed usage string value → re-packages
- unreadable installed Info.plist → re-packages (treated as missing)

## Spec refs
SPEC Amendment 11 (voice); task 063.

## Notes
Found 2026-10-22 on Eric's Mac after updating to 0.2.0. Workaround: `/snapsolve uninstall` (keep history) then `/snapsolve install`.
