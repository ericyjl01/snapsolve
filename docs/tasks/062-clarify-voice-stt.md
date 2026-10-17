# 062 · Clarify voice follow-up: speech-to-text engine and mic permission

## Objective
Before 063 can be built, Eric picks how speech becomes text. Electron's `webkitSpeechRecognition` does not work in Electron, so every option is a new dependency or service (needs approval: ARCHITECTURE `## Approved libraries`).

## Question for Eric
Which speech-to-text engine?
1. **Local Whisper** (whisper.cpp via a Node binding or bundled binary; a ~150 MB model downloaded at install) — private, offline, no per-use cost, adds install size and a native build.
2. **macOS's own speech recognizer** (SFSpeechRecognizer through a small native helper) — no model download, needs a Swift helper binary and the Speech Recognition permission.
3. **A cloud API** (e.g. OpenAI or Deepgram) — simplest code, needs an API key and sends audio off the Mac.

Ending dictation is settled: Ctrl+Option+V again (DECISIONS 2026-10-17 hotkeys), so no focus or Input Monitoring question remains.

## Done when
- [ ] DECISIONS row with Eric's answers, verbatim
- [ ] ARCHITECTURE `## Approved libraries` updated if a dependency was approved
- [ ] 063's Scope updated to the chosen engine

## Spec refs
ARCHITECTURE `## Approved libraries`, `## Do NOT`.
