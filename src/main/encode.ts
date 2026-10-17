// The image sent to the model (SPEC §2.3): long edge capped at 2576 px, PNG unless that is over 3 MB, then JPEG 85.
// Pure over `ImageLike`, which Electron's `nativeImage` satisfies.

export const MAX_LONG_EDGE = 2576;
export const MAX_PNG_BYTES = 3 * 1024 * 1024;
export const JPEG_QUALITY = 85;

export interface ImageLike {
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality?: "good" | "better" | "best" }): ImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

export interface EncodedImage {
  buf: Buffer;
  mime: "image/png" | "image/jpeg";
  /** Size of the sent image (after any resize). */
  width: number;
  height: number;
}

export function encodeForModel(img: ImageLike): EncodedImage {
  const { width, height } = img.getSize();
  const long = Math.max(width, height);
  let send = img;
  let size = { width, height };
  if (long > MAX_LONG_EDGE) {
    size = { width: Math.round((width * MAX_LONG_EDGE) / long), height: Math.round((height * MAX_LONG_EDGE) / long) };
    send = img.resize({ ...size, quality: "best" });
  }
  const png = send.toPNG();
  if (png.length > MAX_PNG_BYTES) return { buf: send.toJPEG(JPEG_QUALITY), mime: "image/jpeg", ...size };
  return { buf: png, mime: "image/png", ...size };
}
