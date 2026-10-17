import { describe, expect, it } from "vitest";
import { encodeForModel, type ImageLike } from "../../src/main/encode";

const MB = 1024 * 1024;

/** An image whose PNG and JPEG encodings have chosen byte sizes; records resize and toJPEG calls. */
class FakeImage implements ImageLike {
  readonly resizes: { width: number; height: number; quality?: string }[] = [];
  readonly jpegQualities: number[] = [];
  readonly png: Buffer;
  readonly jpeg: Buffer;
  resized: FakeImage | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly pngBytes = 1000,
    readonly resizedPngBytes = 1000,
  ) {
    this.png = Buffer.alloc(pngBytes, 1);
    this.jpeg = Buffer.alloc(500, 2);
  }

  getSize() {
    return { width: this.width, height: this.height };
  }

  resize(options: { width: number; height: number; quality?: "good" | "better" | "best" }): ImageLike {
    this.resizes.push(options);
    this.resized = new FakeImage(options.width, options.height, this.resizedPngBytes);
    return this.resized;
  }

  toPNG(): Buffer {
    return this.png;
  }

  toJPEG(quality: number): Buffer {
    this.jpegQualities.push(quality);
    return this.jpeg;
  }
}

describe("encodeForModel", () => {
  it("1920×1200 PNG under 3 MB → the same PNG, image/png, no resize", () => {
    const img = new FakeImage(1920, 1200, 2 * MB);
    const out = encodeForModel(img);
    expect(out.buf).toBe(img.png);
    expect(out).toMatchObject({ mime: "image/png", width: 1920, height: 1200 });
    expect(img.resizes).toEqual([]);
    expect(img.jpegQualities).toEqual([]);
  });

  it("3840×2160 → resized to 2576×1449 with quality best; sends the resized PNG", () => {
    const img = new FakeImage(3840, 2160, 5 * MB, 2 * MB);
    const out = encodeForModel(img);
    expect(img.resizes).toEqual([{ width: 2576, height: 1449, quality: "best" }]);
    expect(out.buf).toBe(img.resized?.png);
    expect(out).toMatchObject({ mime: "image/png", width: 2576, height: 1449 });
  });

  it("1200×4000 portrait → long edge 2576 (773×2576)", () => {
    const img = new FakeImage(1200, 4000);
    expect(encodeForModel(img)).toMatchObject({ width: 773, height: 2576 });
    expect(img.resizes).toEqual([{ width: 773, height: 2576, quality: "best" }]);
  });

  it("3000×3000 square → 2576×2576", () => {
    const img = new FakeImage(3000, 3000);
    expect(encodeForModel(img)).toMatchObject({ width: 2576, height: 2576 });
  });

  it("a long edge of exactly 2576 is unchanged", () => {
    const img = new FakeImage(2576, 1449);
    const out = encodeForModel(img);
    expect(img.resizes).toEqual([]);
    expect(out).toMatchObject({ width: 2576, height: 1449, mime: "image/png" });
    expect(out.buf).toBe(img.png);
  });

  it("PNG over 3 MB → JPEG quality 85, image/jpeg", () => {
    const img = new FakeImage(1920, 1200, 3 * MB + 1);
    const out = encodeForModel(img);
    expect(img.jpegQualities).toEqual([85]);
    expect(out.buf).toBe(img.jpeg);
    expect(out).toMatchObject({ mime: "image/jpeg", width: 1920, height: 1200 });
  });

  it("PNG of exactly 3 MB stays PNG", () => {
    const img = new FakeImage(1920, 1200, 3 * MB);
    const out = encodeForModel(img);
    expect(out.mime).toBe("image/png");
    expect(img.jpegQualities).toEqual([]);
  });

  it("resized but still over 3 MB → JPEG of the resized image, not the original", () => {
    const img = new FakeImage(5120, 2880, 20 * MB, 4 * MB);
    const out = encodeForModel(img);
    const resized = img.resized as FakeImage;
    expect(resized.jpegQualities).toEqual([85]);
    expect(img.jpegQualities).toEqual([]);
    expect(out.buf).toBe(resized.jpeg);
    expect(out).toMatchObject({ mime: "image/jpeg", width: 2576, height: 1449 });
  });
});
