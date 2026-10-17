// Screen capture (SPEC §2.1–2.2): the display under the cursor at native resolution, one capture at a time, with
// the panel kept out of the image (content protection on Windows 10 2004+, else hide → wait → capture → re-show).
// On macOS nothing is captured without the Screen Recording grant (DESIGN §3.2 step 5).
import { SnapsolveError } from "../shared/errors";
import type { Thread } from "../shared/types";
import { encodeForModel, type EncodedImage, type ImageLike } from "./encode";

/** Windows 10 version 2004: from this build, content protection removes the panel from captures. */
const CONTENT_PROTECTION_BUILD = 19041;
const HIDE_WAIT_MS = 150;

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  bounds: Point & Size;
  size: Size;
  scaleFactor: number;
}

export interface SourceLike {
  /** Empty on some platforms and drivers. */
  display_id: string;
  thumbnail: ImageLike;
}

export interface CapturerDeps {
  desktopCapturer: { getSources(options: { types: ["screen"]; thumbnailSize: Size }): Promise<SourceLike[]> };
  screen: { getCursorScreenPoint(): Point; getDisplayNearestPoint(point: Point): DisplayLike };
  /** `isOpen`: slid out (a collapsed edge tab is not open). */
  panel: { isOpen(): boolean; hide(): void; show(): void };
  /** Electron's `systemPreferences`: the macOS Screen Recording state; asked only on darwin. */
  mediaAccess: { getMediaAccessStatus(kind: "screen"): string };
  platform: NodeJS.Platform;
  /** `os.release()`; on Windows `10.0.<build>`. */
  osRelease: string;
  wait: (ms: number) => Promise<void>;
}

export interface Screenshot {
  /** Full resolution, for the thread's history. */
  png: Buffer;
  width: number;
  height: number;
  /** What the model receives (SPEC §2.3). */
  send: EncodedImage;
}

export interface Capturer {
  /**
   * Captures run one at a time in call order; a failure rejects with `captureFailed` (on macOS without the Screen
   * Recording grant: `screenRecordingDenied`) and frees the next.
   */
  capture(): Promise<Screenshot>;
}

/** `screenRecordingDenied`, plus whether this capture just raised macOS's permission prompt (the card then asks to relaunch). */
export class ScreenRecordingDeniedError extends SnapsolveError {
  readonly prompted: boolean;

  constructor(prompted: boolean, options?: { cause?: unknown }) {
    super(
      "screenRecordingDenied",
      !prompted
        ? "Screen Recording is denied or restricted"
        : options?.cause === undefined
          ? "Screen Recording not determined; the system prompt was shown"
          : "Screen Recording not determined; the getSources call meant to show the system prompt failed",
      options,
    );
    this.prompted = prompted;
  }
}

export function createCapturer(deps: CapturerDeps): Capturer {
  const hidesPanel = !hasContentProtection(deps.platform, deps.osRelease);
  let tail: Promise<unknown> = Promise.resolve();

  async function captureNow(): Promise<Screenshot> {
    if (deps.platform === "darwin") await requireScreenRecording();
    const hide = hidesPanel && deps.panel.isOpen();
    let thumbnail: ImageLike;
    try {
      if (hide) {
        deps.panel.hide();
        await deps.wait(HIDE_WAIT_MS);
      }
      thumbnail = await grab();
    } finally {
      if (hide) deps.panel.show();
    }
    const { width, height } = thumbnail.getSize();
    if (width <= 0 || height <= 0) throw new SnapsolveError("captureFailed", "the captured image is empty");
    return { png: thumbnail.toPNG(), width, height, send: encodeForModel(thumbnail) };
  }

  /** Throws `ScreenRecordingDeniedError` unless granted; an undetermined state first raises the system prompt. */
  async function requireScreenRecording(): Promise<void> {
    const status = deps.mediaAccess.getMediaAccessStatus("screen");
    if (status === "granted") return;
    if (status !== "not-determined") throw new ScreenRecordingDeniedError(false);
    try {
      // One getSources call registers snapsolve with macOS and shows the prompt; no thumbnail, nothing is kept.
      await deps.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    } catch (cause) {
      // The card says what to do either way; the cause goes to the log with the error.
      throw new ScreenRecordingDeniedError(true, { cause });
    }
    throw new ScreenRecordingDeniedError(true);
  }

  async function grab(): Promise<ImageLike> {
    const display = deps.screen.getDisplayNearestPoint(deps.screen.getCursorScreenPoint());
    const wanted = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    let sources: SourceLike[];
    try {
      sources = await deps.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: wanted });
    } catch (e) {
      throw new SnapsolveError("captureFailed", `getSources failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    const source =
      sources.find((s) => s.display_id === String(display.id)) ??
      sources.find((s) => {
        const got = s.thumbnail.getSize();
        return got.width === wanted.width && got.height === wanted.height;
      }) ??
      sources[0];
    if (!source) throw new SnapsolveError("captureFailed", "no screen sources");
    return source.thumbnail;
  }

  return {
    capture() {
      const run = tail.then(captureNow);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** Whether a new screenshot may join `thread` (SPEC §2.3); at the cap the next one starts a new thread. */
export function decideAppend(thread: Thread, max: number): "append" | "newThread" {
  const shots = thread.turns.filter((t) => t.role === "user" && t.kind === "screenshot").length;
  return shots < max ? "append" : "newThread";
}

/** Windows 10 2004+ removes a content-protected window from captures; an unreadable build takes the hide path. */
function hasContentProtection(platform: NodeJS.Platform, osRelease: string): boolean {
  if (platform !== "win32") return false;
  const build = Number(osRelease.split(".")[2]);
  return Number.isInteger(build) && build >= CONTENT_PROTECTION_BUILD;
}
