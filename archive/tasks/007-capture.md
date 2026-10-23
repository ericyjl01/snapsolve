# 007 · Image encoding and capture

## Objective
SPEC §2.1–2.3: capture the cursor's display at native resolution and produce the image sent to the model.

## Scope
In:  `src/main/encode.ts` `encodeForModel(img)` over an `ImageLike` interface (`getSize`, `resize`, `toPNG`, `toJPEG`) → `{ buf, mime, width, height }`; `src/main/capture.ts` `createCapturer({ desktopCapturer, screen, panel, platform, osRelease, wait })` → `capture()` returning the full-res PNG + send image; capture mutex; platform panel handling (win32 ≥ build 19041: no hide; older win32 and darwin: hide-if-open → wait 150 ms → capture → re-show); `decideAppend(thread, max)`.
Out: macOS permission state machine (M3); wiring to hotkeys (010).

## Done when
- [ ] task tests pass; `npm run build` exits 0

## Tests
Command: `npx vitest run test/unit/encode.test.ts test/unit/capture.test.ts`
- encode: 1920×1200 PNG < 3 MB → same PNG, `image/png`; 3840×2160 → 2576×1449; 1200×4000 portrait → long edge 2576; exactly 2576 → unchanged; PNG > 3 MB → JPEG q85, `image/jpeg`.
- capture display: two-display layout picks the display under the cursor; thumbnailSize = size × scaleFactor (1280×800 @1.5 → 1920×1200).
- capture source: `display_id` match wins; empty `display_id` → size match; no match → first source; reported size comes from `getSize()`, not the request.
- mutex: two overlapping captures run one after another, both resolve, order kept.
- platform: win32 build 26200 with panel open → no hide; darwin with panel open → hide, wait 150, capture, show; darwin collapsed → no hide; win32 build 18363 → hide path.
- failure: `getSources` rejects → `captureFailed` error; panel re-shown on the hide path even on failure.
- decideAppend: 5 screenshots → `append`; 6 → `newThread`.

## Spec refs
SPEC §2.1, §2.2, §2.3.

## Notes
