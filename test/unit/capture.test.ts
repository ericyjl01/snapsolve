import { describe, expect, it } from "vitest";
import { SnapsolveError } from "../../src/shared/errors";
import {
  createCapturer,
  decideAppend,
  ScreenRecordingDeniedError,
  type CapturerDeps,
  type DisplayLike,
  type SourceLike,
} from "../../src/main/capture";
import type { ImageLike } from "../../src/main/encode";
import type { Thread, Turn } from "../../src/shared/types";

class FakeThumb implements ImageLike {
  readonly png: Buffer;
  constructor(
    readonly width: number,
    readonly height: number,
    tag = "img",
  ) {
    this.png = Buffer.from(`${tag}:${width}x${height}`);
  }
  getSize() {
    return { width: this.width, height: this.height };
  }
  resize(options: { width: number; height: number }): ImageLike {
    return new FakeThumb(options.width, options.height, "resized");
  }
  toPNG(): Buffer {
    return this.png;
  }
  toJPEG(): Buffer {
    return Buffer.from("jpeg");
  }
}

const LEFT: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
const RIGHT: DisplayLike = { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 800 }, size: { width: 1280, height: 800 }, scaleFactor: 1.5 };

interface Harness {
  deps: CapturerDeps;
  events: string[];
  /** Every getMediaAccessStatus call, kept apart from `events` so the panel-order tests above stay exact. */
  statusChecks: string[];
  requests: { types: string[]; thumbnailSize: { width: number; height: number } }[];
  panel: { open: boolean };
}

function harness(
  options: {
    displays?: DisplayLike[];
    cursor?: { x: number; y: number };
    sources?: () => SourceLike[] | Promise<SourceLike[]>;
    platform?: NodeJS.Platform;
    osRelease?: string;
    panelOpen?: boolean;
    /** What `getMediaAccessStatus("screen")` returns; a function to change it between captures. */
    mediaStatus?: string | (() => string);
  } = {},
): Harness {
  const displays = options.displays ?? [LEFT, RIGHT];
  const events: string[] = [];
  const statusChecks: string[] = [];
  const requests: Harness["requests"] = [];
  const panel = { open: options.panelOpen ?? true };
  const deps: CapturerDeps = {
    screen: {
      getCursorScreenPoint: () => options.cursor ?? { x: 100, y: 100 },
      getDisplayNearestPoint: (p) =>
        displays.find((d) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height) ??
        displays[0],
    },
    // Both async fakes settle on a later timer turn and record when they finish, so a step that does not wait for
    // the one before it shows up in `events` (a missing await, a re-show before the capture settles).
    desktopCapturer: {
      getSources: async (request) => {
        requests.push(request);
        events.push("getSources");
        const sources = options.sources ?? (() => [{ display_id: "1", thumbnail: new FakeThumb(1920, 1080) }]);
        try {
          const result = await sources();
          await later();
          events.push("got sources");
          return result;
        } catch (e) {
          await later();
          events.push("getSources failed");
          throw e;
        }
      },
    },
    panel: {
      isOpen: () => panel.open,
      hide: () => {
        events.push("hide");
      },
      show: () => {
        events.push("show");
      },
    },
    mediaAccess: {
      getMediaAccessStatus: (kind) => {
        statusChecks.push(kind);
        const status = options.mediaStatus ?? "granted";
        return typeof status === "function" ? status() : status;
      },
    },
    platform: options.platform ?? "win32",
    osRelease: options.osRelease ?? "10.0.26200",
    wait: async (ms) => {
      events.push(`wait ${ms}`);
      await later();
      events.push("waited");
    },
  };
  return { deps, events, statusChecks, requests, panel };
}

const later = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("capture: display", () => {
  it("picks the display under the cursor of a two-display layout; thumbnailSize = size × scaleFactor", async () => {
    const h = harness({ cursor: { x: 2500, y: 300 }, sources: () => [{ display_id: "2", thumbnail: new FakeThumb(1920, 1200) }] });
    await createCapturer(h.deps).capture();
    expect(h.requests).toEqual([{ types: ["screen"], thumbnailSize: { width: 1920, height: 1200 } }]);
  });

  it("the cursor on the left display requests that display's size", async () => {
    const h = harness({ cursor: { x: 5, y: 5 } });
    await createCapturer(h.deps).capture();
    expect(h.requests[0].thumbnailSize).toEqual({ width: 1920, height: 1080 });
  });
});

describe("capture: source", () => {
  it("a display_id match wins over an earlier source of the requested size", async () => {
    const h = harness({
      cursor: { x: 2500, y: 300 },
      sources: () => [
        { display_id: "1", thumbnail: new FakeThumb(1920, 1200, "wrong") },
        { display_id: "2", thumbnail: new FakeThumb(1920, 1200, "right") },
      ],
    });
    const shot = await createCapturer(h.deps).capture();
    expect(shot.png.toString()).toBe("right:1920x1200");
  });

  it("empty display_id → the source whose size equals the request", async () => {
    const h = harness({
      cursor: { x: 2500, y: 300 },
      sources: () => [
        { display_id: "", thumbnail: new FakeThumb(1920, 1080, "left") },
        { display_id: "", thumbnail: new FakeThumb(1920, 1200, "right") },
      ],
    });
    expect((await createCapturer(h.deps).capture()).png.toString()).toBe("right:1920x1200");
  });

  it("no id or size match → the first source", async () => {
    const h = harness({
      cursor: { x: 2500, y: 300 },
      sources: () => [
        { display_id: "", thumbnail: new FakeThumb(1000, 700, "first") },
        { display_id: "", thumbnail: new FakeThumb(900, 600, "second") },
      ],
    });
    expect((await createCapturer(h.deps).capture()).png.toString()).toBe("first:1000x700");
  });

  it("the reported size comes from getSize(), not the request; send is the encoded image", async () => {
    const h = harness({ cursor: { x: 2500, y: 300 }, sources: () => [{ display_id: "2", thumbnail: new FakeThumb(1918, 1199, "odd") }] });
    const shot = await createCapturer(h.deps).capture();
    expect(shot).toMatchObject({ width: 1918, height: 1199 });
    expect(shot.png.toString()).toBe("odd:1918x1199");
    expect(shot.send).toEqual({ buf: shot.png, mime: "image/png", width: 1918, height: 1199 });
  });
});

describe("capture: full resolution vs sent image", () => {
  it("a 3840×2160 capture keeps the full-size PNG and sends the image resized to 2576×1449", async () => {
    const h = harness({ sources: () => [{ display_id: "1", thumbnail: new FakeThumb(3840, 2160, "uhd") }] });
    const shot = await createCapturer(h.deps).capture();
    expect(shot).toMatchObject({ width: 3840, height: 2160 });
    expect(shot.png.toString()).toBe("uhd:3840x2160");
    expect(shot.send).toMatchObject({ mime: "image/png", width: 2576, height: 1449 });
    expect(shot.send.buf.toString()).toBe("resized:2576x1449");
  });
});

describe("capture: mutex", () => {
  it("two overlapping captures run one after another, both resolve, order kept", async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const h = harness({
      sources: () => {
        const tag = `shot${++n}`;
        return new Promise<SourceLike[]>((resolve) => releases.push(() => resolve([{ display_id: "1", thumbnail: new FakeThumb(1920, 1080, tag) }])));
      },
    });
    const capturer = createCapturer(h.deps);
    const done: string[] = [];
    const a = capturer.capture().then((s) => done.push(s.png.toString()));
    const b = capturer.capture().then((s) => done.push(s.png.toString()));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.requests).toHaveLength(1);
    releases[0]();
    await a;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.requests).toHaveLength(2);
    releases[1]();
    await b;
    expect(done).toEqual(["shot1:1920x1080", "shot2:1920x1080"]);
  });

  it("a failed capture does not block the next one", async () => {
    let n = 0;
    const h = harness({
      sources: () => {
        if (++n === 1) throw new Error("boom");
        return [{ display_id: "1", thumbnail: new FakeThumb(1920, 1080) }];
      },
    });
    const capturer = createCapturer(h.deps);
    const [a, b] = await Promise.allSettled([capturer.capture(), capturer.capture()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });
});

describe("capture: panel handling per platform", () => {
  it("win32 build 26200 with the panel open → no hide, no wait", async () => {
    const h = harness({ platform: "win32", osRelease: "10.0.26200", panelOpen: true });
    await createCapturer(h.deps).capture();
    expect(h.events).toEqual(["getSources", "got sources"]);
  });

  it("win32 build 19041 (10 version 2004) → no hide", async () => {
    const h = harness({ platform: "win32", osRelease: "10.0.19041", panelOpen: true });
    await createCapturer(h.deps).capture();
    expect(h.events).toEqual(["getSources", "got sources"]);
  });

  it("darwin with the panel open → hide, wait 150, capture, show", async () => {
    const h = harness({ platform: "darwin", osRelease: "24.1.0", panelOpen: true });
    await createCapturer(h.deps).capture();
    expect(h.events).toEqual(["hide", "wait 150", "waited", "getSources", "got sources", "show"]);
  });

  it("darwin with the panel collapsed → no hide", async () => {
    const h = harness({ platform: "darwin", osRelease: "24.1.0", panelOpen: false });
    await createCapturer(h.deps).capture();
    expect(h.events).toEqual(["getSources", "got sources"]);
  });

  it("win32 build 18363 → the hide path", async () => {
    const h = harness({ platform: "win32", osRelease: "10.0.18363", panelOpen: true });
    await createCapturer(h.deps).capture();
    expect(h.events).toEqual(["hide", "wait 150", "waited", "getSources", "got sources", "show"]);
  });

  it("win32 with an unreadable build number → the hide path (keeps the panel out of the image)", async () => {
    const h = harness({ platform: "win32", osRelease: "unknown", panelOpen: true });
    await createCapturer(h.deps).capture();
    expect(h.events).toEqual(["hide", "wait 150", "waited", "getSources", "got sources", "show"]);
  });
});

describe("capture: failure", () => {
  it("getSources rejects → captureFailed; the panel is re-shown on the hide path", async () => {
    const h = harness({
      platform: "darwin",
      osRelease: "24.1.0",
      sources: () => Promise.reject(new Error("screen capture failed")),
    });
    await expect(createCapturer(h.deps).capture()).rejects.toMatchObject({ name: "SnapsolveError", kind: "captureFailed" });
    expect(h.events).toEqual(["hide", "wait 150", "waited", "getSources", "getSources failed", "show"]);
  });

  it("no sources at all → captureFailed", async () => {
    const h = harness({ sources: () => [] });
    await expect(createCapturer(h.deps).capture()).rejects.toMatchObject({ kind: "captureFailed" });
  });

  it("an empty thumbnail (0×0) → captureFailed", async () => {
    const h = harness({ sources: () => [{ display_id: "1", thumbnail: new FakeThumb(0, 0) }] });
    await expect(createCapturer(h.deps).capture()).rejects.toMatchObject({ kind: "captureFailed" });
  });
});

describe("decideAppend", () => {
  const shots = (n: number): Turn[] =>
    Array.from({ length: n }, (_, i): Turn => ({ role: "user", kind: "screenshot", file: `${String(i + 1).padStart(3, "0")}.png` }));
  const thread = (turns: Turn[]): Thread => ({
    id: "6f1c2d3e-4a5b-4c6d-8e7f-001122334455",
    sessionId: "0b8f6a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b",
    transcriptPath: null,
    model: "opus",
    effort: "high",
    createdAt: "2026-10-14T08:00:00.000Z",
    title: "",
    status: "done",
    turns,
  });

  it("5 screenshots → append", () => {
    expect(decideAppend(thread(shots(5)), 6)).toBe("append");
  });

  it("6 screenshots → newThread", () => {
    expect(decideAppend(thread(shots(6)), 6)).toBe("newThread");
  });

  it("text turns and answers do not count toward the cap", () => {
    const turns: Turn[] = [
      ...shots(5),
      { role: "user", kind: "text", text: "why?" },
      { role: "assistant", text: "because", durationMs: 1, ttftMs: 1, costUsd: 0, isError: false },
    ];
    expect(decideAppend(thread(turns), 6)).toBe("append");
  });
});

describe("capture: macOS Screen Recording permission (029)", () => {
  async function rejection(promise: Promise<unknown>): Promise<ScreenRecordingDeniedError> {
    try {
      await promise;
    } catch (e) {
      return e as ScreenRecordingDeniedError;
    }
    throw new Error("expected a rejection");
  }

  it("granted → the normal capture, the status checked once per capture before the panel is touched", async () => {
    let eventsAtCheck = -1;
    const h = harness({ platform: "darwin", mediaStatus: () => ((eventsAtCheck = h.events.length), "granted") });
    const capturer = createCapturer(h.deps);
    const shot = await capturer.capture();
    expect(shot.png.toString()).toBe("img:1920x1080");
    expect(eventsAtCheck).toBe(0);
    expect(h.events[0]).toBe("hide");
    await capturer.capture();
    expect(h.statusChecks).toEqual(["screen", "screen"]);
  });

  it("not-determined → one getSources call to raise the system prompt, no image, screenRecordingDenied with prompted; panel left alone", async () => {
    const h = harness({ platform: "darwin", mediaStatus: "not-determined", panelOpen: true });
    const error = await rejection(createCapturer(h.deps).capture());
    expect(error).toBeInstanceOf(SnapsolveError);
    expect(error.kind).toBe("screenRecordingDenied");
    expect(error.prompted).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.events).not.toContain("hide");
    expect(h.events).not.toContain("show");
  });

  it("not-determined and the prompting getSources itself rejects → still screenRecordingDenied with prompted", async () => {
    const noPermission = new Error("no permission");
    const h = harness({
      platform: "darwin",
      mediaStatus: "not-determined",
      sources: () => {
        throw noPermission;
      },
    });
    const error = await rejection(createCapturer(h.deps).capture());
    expect(error.kind).toBe("screenRecordingDenied");
    expect(error.prompted).toBe(true);
    // Not swallowed: the getSources failure travels as the cause (log.ts writes it) and the message says so.
    expect(error.cause).toBe(noPermission);
    expect(error.message).toMatch(/failed/);
  });

  it.each(["denied", "restricted", "something-new"])("%s → screenRecordingDenied, not prompted; no getSources; panel never hidden", async (status) => {
    const h = harness({ platform: "darwin", mediaStatus: status, panelOpen: true });
    const error = await rejection(createCapturer(h.deps).capture());
    expect(error).toBeInstanceOf(SnapsolveError);
    expect(error.kind).toBe("screenRecordingDenied");
    expect(error.prompted).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(h.events).toEqual([]);
    expect(h.statusChecks).toEqual(["screen"]);
  });

  it("win32 never asks for the media access status", async () => {
    const h = harness({ platform: "win32", mediaStatus: "denied" });
    await createCapturer(h.deps).capture();
    expect(h.statusChecks).toEqual([]);
  });

  it("a denied capture frees the mutex: once granted, the next capture runs and succeeds", async () => {
    let checks = 0;
    const h = harness({ platform: "darwin", mediaStatus: () => (checks++ === 0 ? "denied" : "granted"), panelOpen: false });
    const capturer = createCapturer(h.deps);
    const first = capturer.capture();
    const second = capturer.capture();
    const error = await rejection(first);
    expect(error.kind).toBe("screenRecordingDenied");
    expect((await second).png.toString()).toBe("img:1920x1080");
  });
});
