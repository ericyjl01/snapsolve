import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOG_BYTES, createLogger } from "../../src/main/log";
import { SnapsolveError } from "../../src/shared/errors";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const now = () => NOW;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "snapsolve-log-"));
  file = path.join(dir, "logs", "snapsolve.log");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function records(f: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(f, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("createLogger", () => {
  it("writes one JSON line per call, ts/level/event first", async () => {
    const log = createLogger(file, { now });
    log.info("app.start", { version: "0.1.0" });
    log.warn("config.warning", { message: "m" });
    log.error("runner.crash", { code: 1 });
    log.debug("tick");
    await log.flush();

    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(4);
    const recs = await records(file);
    const ts = NOW.toISOString();
    expect(recs).toEqual([
      { ts, level: "info", event: "app.start", version: "0.1.0" },
      { ts, level: "warn", event: "config.warning", message: "m" },
      { ts, level: "error", event: "runner.crash", code: 1 },
      { ts, level: "debug", event: "tick" },
    ]);
    expect(Object.keys(recs[0]!).slice(0, 3)).toEqual(["ts", "level", "event"]);
  });

  it("creates a missing log directory", async () => {
    const deep = path.join(dir, "a", "b", "logs", "snapsolve.log");
    const log = createLogger(deep, { now });
    log.info("hello");
    await log.flush();
    expect(await records(deep)).toHaveLength(1);
  });

  it("keeps lines in call order", async () => {
    const log = createLogger(file, { now });
    for (let i = 0; i < 200; i++) log.info("n", { i });
    await log.flush();
    expect((await records(file)).map((r) => r.i)).toEqual([...Array(200).keys()]);
  });

  it("redacts data, image, base64, text, prompt, answer and email keys at any depth, any case", async () => {
    const log = createLogger(file, { now });
    log.info("turn.start", {
      threadId: "t1",
      dir: "C:\\data",
      Text: "solve this",
      answer: "x = 2",
      EMAIL: "a@b.c",
      request: {
        prompt: "p",
        content: [{ type: "image", image: "iVBOR", source: { data: "AAAA", base64: "BBBB", media_type: "image/png" } }],
      },
    });
    await log.flush();
    const [rec] = await records(file);
    expect(rec).toEqual({
      ts: NOW.toISOString(),
      level: "info",
      event: "turn.start",
      threadId: "t1",
      dir: "C:\\data",
      Text: "[redacted]",
      answer: "[redacted]",
      EMAIL: "[redacted]",
      request: {
        prompt: "[redacted]",
        content: [
          { type: "image", image: "[redacted]", source: { data: "[redacted]", base64: "[redacted]", media_type: "image/png" } },
        ],
      },
    });
    const raw = await readFile(file, "utf8");
    for (const secret of ["solve this", "x = 2", "a@b.c", "iVBOR", "AAAA", "BBBB"]) expect(raw).not.toContain(secret);
  });

  it("logs byte buffers as their size, never their contents", async () => {
    const log = createLogger(file, { now });
    log.info("capture.saved", { png: Buffer.from("PNGSECRET"), raw: new Uint8Array(3) });
    await log.flush();
    const [rec] = await records(file);
    expect(rec).toMatchObject({ png: "[9 bytes]", raw: "[3 bytes]" });
    expect(await readFile(file, "utf8")).not.toContain("PNGSECRET");
  });

  it("fields cannot override ts, level or event", async () => {
    const log = createLogger(file, { now });
    log.info("real", { ts: "fake", level: "error", event: "fake" });
    await log.flush();
    const [rec] = await records(file);
    expect(rec).toMatchObject({ ts: NOW.toISOString(), level: "info", event: "real" });
  });

  it("serializes errors by name, message and kind, and redacts inside their causes", async () => {
    const log = createLogger(file, { now });
    const cause = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    log.error("runner.spawn", { err: new SnapsolveError("claudeNotFound", "claude missing", { cause }) });
    await log.flush();
    const [rec] = await records(file);
    expect(rec!.err).toMatchObject({
      name: "SnapsolveError",
      message: "claude missing",
      kind: "claudeNotFound",
      cause: { name: "Error", message: "spawn claude ENOENT", code: "ENOENT" },
    });
  });

  it("never throws on fields JSON cannot handle (cycles, bigint, throwing getters)", async () => {
    const log = createLogger(file, { now });
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const shared = { k: 1 };
    const hostile = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    expect(() => log.info("weird", { loop, n: 10n, pair: [shared, shared] })).not.toThrow();
    expect(() => log.info("hostile", { hostile })).not.toThrow();
    await log.flush();
    const [weird, bad] = await records(file);
    expect(weird).toMatchObject({ loop: { name: "loop", self: "[circular]" }, n: "10", pair: [{ k: 1 }, { k: 1 }] });
    expect(bad).toMatchObject({ level: "info", event: "hostile" });
  });

  it("rotates to .1 when the next line would pass the size limit", async () => {
    const lineBytes = Buffer.byteLength(JSON.stringify({ ts: NOW.toISOString(), level: "info", event: "e1" }) + "\n");
    const maxBytes = Math.floor(lineBytes * 2.5);
    const log = createLogger(file, { now, maxBytes });
    for (const e of ["e1", "e2", "e3", "e4", "e5"]) log.info(e);
    await log.flush();
    // e1 e2 | e3 rotates them out | e3 e4 | e5 rotates them out (replacing the old .1)
    expect((await records(`${file}.1`)).map((r) => r.event)).toEqual(["e3", "e4"]);
    expect((await records(file)).map((r) => r.event)).toEqual(["e5"]);
    expect((await stat(file)).size).toBeLessThanOrEqual(maxBytes);
  });

  it("rotates at 5 MB by default, counting what is already on disk", async () => {
    expect(MAX_LOG_BYTES).toBe(5 * 1024 * 1024);
    await mkdir(path.dirname(file), { recursive: true });
    const existing = Buffer.alloc(MAX_LOG_BYTES - 10, "a");
    await writeFile(file, existing);
    const log = createLogger(file, { now });
    log.info("after");
    await log.flush();
    expect((await stat(`${file}.1`)).size).toBe(existing.length);
    expect((await records(file)).map((r) => r.event)).toEqual(["after"]);
  });

  it("swallows write errors after one stderr note", async () => {
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "a file where the log dir should be");
    const stderr = vi.fn();
    const log = createLogger(path.join(blocker, "logs", "snapsolve.log"), { now, stderr });
    expect(() => {
      log.info("one");
      log.warn("two");
      log.error("three");
    }).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    log.info("four");
    await log.flush();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toMatch(/snapsolve.*log/i);
  });
});
