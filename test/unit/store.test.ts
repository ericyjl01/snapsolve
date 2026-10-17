import * as fsp from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/main/log";
import { createStore, writeJsonAtomic, type StoreDeps } from "../../src/main/store";
import type { Thread, Turn } from "../../src/shared/types";

// Pass-through spy so one test can make the atomic rename fail (a failed write mid-way).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);

interface Entry {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

let root: string;
let dataDir: string;
let threadsDir: string;
let sessionsDir: string;
let projectsDir: string;
let entries: Entry[];
let log: Logger;
let purge: ReturnType<typeof vi.fn<(dir: string) => Promise<void>>>;
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snapsolve-store-"));
  dataDir = path.join(root, "data");
  threadsDir = path.join(dataDir, "threads");
  sessionsDir = path.join(dataDir, "sessions");
  projectsDir = path.join(root, "claude", "projects");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  entries = [];
  const rec = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    entries.push({ level, event, fields });
  };
  log = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error"), flush: async () => {} };
  purge = vi.fn(async (_dir: string) => {});
  clock = Date.parse("2026-10-14T08:00:00.000Z");
});
afterEach(async () => {
  vi.mocked(fsp.rename).mockReset();
  vi.mocked(fsp.rename).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename);
  await rm(root, { recursive: true, force: true });
});

function makeStore(over: Partial<StoreDeps> = {}) {
  return createStore({
    dataDir,
    projectsDir,
    purge,
    log,
    now: () => new Date((clock += 1000)),
    ...over,
  });
}

async function readThreadJson(id: string): Promise<Thread> {
  return JSON.parse(await readFile(path.join(threadsDir, id, "thread.json"), "utf8")) as Thread;
}

async function expectKind(p: Promise<unknown>, kind: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ name: "SnapsolveError", kind });
}

const errno = (code: string) => Object.assign(new Error(code), { code });

/** Files directly in the temp root, without the store's own directories. */
async function rootFiles(): Promise<string[]> {
  return (await readdir(root)).filter((f) => f !== "data" && f !== "claude");
}

const userText = (text: string): Turn => ({ role: "user", kind: "text", text });
const answer = (text: string): Turn => ({
  role: "assistant",
  text,
  durationMs: 1200,
  ttftMs: 300,
  costUsd: 0.01,
  isError: false,
});

describe("createThread", () => {
  it("writes thread.json with a UUID id, a UUID sessionId and status new", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    expect(t.id).toMatch(UUID_V4);
    expect(t.sessionId).toMatch(UUID_V4);
    expect(t.sessionId).not.toBe(t.id);
    expect(t).toMatchObject({
      transcriptPath: null,
      model: "opus",
      effort: "high",
      createdAt: "2026-10-14T08:00:01.000Z",
      title: "",
      status: "new",
      turns: [],
    });
    expect(await readThreadJson(t.id)).toEqual(t);
    expect(await readdir(path.join(threadsDir, t.id))).toEqual(["thread.json"]);
  });

  it("gives every thread its own id and sessionId", async () => {
    const store = makeStore();
    const a = await store.createThread({ model: "opus", effort: "high" });
    const b = await store.createThread({ model: "opus", effort: "high" });
    expect(new Set([a.id, a.sessionId, b.id, b.sessionId]).size).toBe(4);
  });
});

describe("saveScreenshot", () => {
  it("numbers files 001, 002, … and returns paths inside the thread dir", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const s1 = await store.saveScreenshot(t.id, PNG);
    const s2 = await store.saveScreenshot(t.id, Buffer.from("second"));
    const dir = path.join(threadsDir, t.id);
    expect(s1).toEqual({ n: 1, file: "001.png", path: path.join(dir, "001.png") });
    expect(s2).toEqual({ n: 2, file: "002.png", path: path.join(dir, "002.png") });
    expect(path.dirname(s1.path)).toBe(dir);
    expect(await readFile(s1.path)).toEqual(PNG);
    expect((await readFile(s2.path)).toString()).toBe("second");
    expect((await readdir(dir)).sort()).toEqual(["001.png", "002.png", "thread.json"]);
  });

  it("continues the numbering after a reload", async () => {
    const t = await makeStore().createThread({ model: "opus", effort: "high" });
    await makeStore().saveScreenshot(t.id, PNG);
    await makeStore().saveScreenshot(t.id, PNG);
    expect((await makeStore().saveScreenshot(t.id, PNG)).file).toBe("003.png");
  });

  it("concurrent saves get distinct numbers and no file is overwritten", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const saved = await Promise.all([0, 1, 2, 3].map((i) => store.saveScreenshot(t.id, Buffer.from(`png-${i}`))));
    expect(saved.map((s) => s.n).sort()).toEqual([1, 2, 3, 4]);
    for (const [i, s] of saved.entries()) expect((await readFile(s.path)).toString()).toBe(`png-${i}`);
  });

  it("two store instances saving at once never overwrite each other's screenshot", async () => {
    const t = await makeStore().createThread({ model: "opus", effort: "high" });
    const a = makeStore();
    const b = makeStore();
    const saved = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? a : b).saveScreenshot(t.id, Buffer.from(`png-${i}`))),
    );
    expect(new Set(saved.map((s) => s.n)).size).toBe(6);
    for (const [i, s] of saved.entries()) expect((await readFile(s.path)).toString()).toBe(`png-${i}`);
  });

  it("an unknown or invalid thread → threadNotFound, nothing written", async () => {
    const store = makeStore();
    await expectKind(store.saveScreenshot("6f1c2d3e-4a5b-4c6d-8e7f-001122334455", PNG), "threadNotFound");
    await expectKind(store.saveScreenshot("../escape", PNG), "threadNotFound");
    await expect(stat(path.join(dataDir, "escape"))).rejects.toThrow();
    expect(await readdir(threadsDir).catch(() => [])).toEqual([]);
  });
});

describe("appendTurn / updateThread", () => {
  it("turn order survives a reload by a fresh store instance", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const shot: Turn = { role: "user", kind: "screenshot", file: "001.png" };
    await store.appendTurn(t.id, shot);
    await store.appendTurn(t.id, answer("x = 4"));
    const last = await store.appendTurn(t.id, userText("why?"));
    expect(last.turns).toEqual([shot, answer("x = 4"), userText("why?")]);
    expect((await makeStore().getThread(t.id)).turns).toEqual([shot, answer("x = 4"), userText("why?")]);
  });

  it("concurrent appends are all kept, in call order", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await Promise.all([0, 1, 2, 3, 4].map((i) => store.appendTurn(t.id, userText(`q${i}`))));
    expect((await store.getThread(t.id)).turns).toEqual([0, 1, 2, 3, 4].map((i) => userText(`q${i}`)));
  });

  it("updateThread persists status and title and keeps everything else", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await store.appendTurn(t.id, userText("q"));
    const u = await store.updateThread(t.id, { status: "running", title: "Quadratic" });
    expect(u).toEqual({ ...t, status: "running", title: "Quadratic", turns: [userText("q")] });
    expect(await readThreadJson(t.id)).toEqual(u);
  });

  it("an invalid turn or status is refused and the thread is unchanged", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const badTurns = [
      { role: "user", kind: "screenshot", file: "../x.png" },
      { role: "user", kind: "text" },
      { role: "assistant", text: "a" },
      { role: "system", text: "x" },
    ];
    for (const turn of badTurns) await expect(store.appendTurn(t.id, turn as Turn)).rejects.toMatchObject({ name: "SnapsolveError" });
    await expect(store.updateThread(t.id, { status: "paused" as Thread["status"] })).rejects.toMatchObject({ name: "SnapsolveError" });
    expect(await readThreadJson(t.id)).toEqual(t);
  });

  it("appendTurn and updateThread on an unknown thread → threadNotFound", async () => {
    const store = makeStore();
    const ghost = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
    await expectKind(store.appendTurn(ghost, userText("q")), "threadNotFound");
    await expectKind(store.updateThread(ghost, { status: "done" }), "threadNotFound");
    await expect(stat(path.join(threadsDir, ghost))).rejects.toThrow();
  });
});

describe("writeJsonAtomic", () => {
  it("writes pretty JSON with a trailing newline and replaces existing content", async () => {
    const file = path.join(root, "x.json");
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2, b: [1] });
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify({ a: 2, b: [1] }, null, 2)}\n`);
    expect(await readdir(root)).toEqual(expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });

  it("a failed write leaves the previous content intact and no temp file", async () => {
    const file = path.join(root, "x.json");
    await writeJsonAtomic(file, { v: "old" });
    vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    await expect(writeJsonAtomic(file, { v: "new" })).rejects.toThrow();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ v: "old" });
    expect((await readdir(root)).filter((f) => f !== "data" && f !== "claude")).toEqual(["x.json"]);
  });

  it("an unserializable value rejects and leaves the file untouched", async () => {
    const file = path.join(root, "x.json");
    await writeJsonAtomic(file, { v: "old" });
    await expect(writeJsonAtomic(file, { v: 1n })).rejects.toThrow();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ v: "old" });
    expect((await readdir(root)).filter((f) => f !== "data" && f !== "claude")).toEqual(["x.json"]);
  });

  it("is the store's thread.json writer: a failed update keeps the thread as it was", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    await expect(store.appendTurn(t.id, userText("lost"))).rejects.toThrow();
    expect(await readThreadJson(t.id)).toEqual(t);
    expect(await readdir(path.join(threadsDir, t.id))).toEqual(["thread.json"]);
  });

  it("rename fails EBUSY twice then succeeds → the write lands, no temp file left", async () => {
    const file = path.join(root, "x.json");
    await writeJsonAtomic(file, { v: "old" });
    vi.mocked(fsp.rename).mockRejectedValueOnce(errno("EBUSY")).mockRejectedValueOnce(errno("EBUSY"));
    await writeJsonAtomic(file, { v: "new" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ v: "new" });
    expect(await rootFiles()).toEqual(["x.json"]);
  });

  it("a transient EACCES is retried too", async () => {
    const file = path.join(root, "x.json");
    vi.mocked(fsp.rename).mockRejectedValueOnce(errno("EACCES"));
    await writeJsonAtomic(file, { v: 1 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ v: 1 });
    expect(await rootFiles()).toEqual(["x.json"]);
  });

  it("rename fails EPERM on every try → rejects after the bound, previous content intact, temp removed", async () => {
    const file = path.join(root, "x.json");
    await writeJsonAtomic(file, { v: "old" });
    vi.mocked(fsp.rename).mockRejectedValue(errno("EPERM"));
    const before = vi.mocked(fsp.rename).mock.calls.length;
    const started = Date.now();
    await expect(writeJsonAtomic(file, { v: "new" })).rejects.toMatchObject({ code: "EPERM" });
    const elapsed = Date.now() - started;
    expect(vi.mocked(fsp.rename).mock.calls.length - before).toBeGreaterThan(2);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1000);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ v: "old" });
    expect(await rootFiles()).toEqual(["x.json"]);
  });

  it("ENOSPC is not retried (one rename call)", async () => {
    const file = path.join(root, "x.json");
    vi.mocked(fsp.rename).mockRejectedValue(errno("ENOSPC"));
    const before = vi.mocked(fsp.rename).mock.calls.length;
    await expect(writeJsonAtomic(file, { v: 1 })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(vi.mocked(fsp.rename).mock.calls.length - before).toBe(1);
    expect(await rootFiles()).toEqual([]);
  });

  it("a thread update survives a transient EPERM on thread.json", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    vi.mocked(fsp.rename).mockRejectedValueOnce(errno("EPERM"));
    const saved = await store.appendTurn(t.id, userText("kept"));
    expect(saved.turns).toEqual([userText("kept")]);
    expect(await readThreadJson(t.id)).toEqual(saved);
    expect(await readdir(path.join(threadsDir, t.id))).toEqual(["thread.json"]);
  });

  it("leftover .tmp files are ignored by listThreads", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await writeFile(path.join(threadsDir, t.id, "thread.json.0a1b.tmp"), "{ torn");
    await writeFile(path.join(threadsDir, "thread.json.tmp"), "{ torn");
    expect(await store.listThreads()).toEqual([t]);
    expect(entries.filter((e) => e.level === "warn" || e.level === "error")).toEqual([]);
  });
});

describe("listThreads", () => {
  it("newest first", async () => {
    const store = makeStore();
    const a = await store.createThread({ model: "opus", effort: "high" });
    const b = await store.createThread({ model: "sonnet", effort: "low" });
    const c = await store.createThread({ model: "opus", effort: "max" });
    expect((await makeStore().listThreads()).map((t) => t.id)).toEqual([c.id, b.id, a.id]);
  });

  it("no threads/ directory yet → empty list", async () => {
    expect(await makeStore().listThreads()).toEqual([]);
  });

  it("a corrupt thread.json is skipped and logged without its content; the directory is kept", async () => {
    const store = makeStore();
    const good = await store.createThread({ model: "opus", effort: "high" });
    const bad = await store.createThread({ model: "opus", effort: "high" });
    await writeFile(path.join(threadsDir, bad.id, "thread.json"), '{"turns":[{"text":"SECRET ANSWER"');
    expect(await store.listThreads()).toEqual([good]);
    const warned = entries.filter((e) => e.level === "warn" && e.event === "store.threadUnreadable");
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0].fields)).toContain(bad.id);
    expect(JSON.stringify(entries)).not.toContain("SECRET");
    expect(await readdir(path.join(threadsDir, bad.id))).toEqual(["thread.json"]);
  });

  it("a thread.json with the wrong shape or another thread's id is skipped and logged", async () => {
    const store = makeStore();
    const good = await store.createThread({ model: "opus", effort: "high" });
    const wrongId = await store.createThread({ model: "opus", effort: "high" });
    const noTurns = await store.createThread({ model: "opus", effort: "high" });
    const badStatus = await store.createThread({ model: "opus", effort: "high" });
    await writeFile(path.join(threadsDir, wrongId.id, "thread.json"), JSON.stringify({ ...wrongId, id: good.id }));
    const { turns: _t, ...rest } = noTurns;
    await writeFile(path.join(threadsDir, noTurns.id, "thread.json"), JSON.stringify(rest));
    await writeFile(path.join(threadsDir, badStatus.id, "thread.json"), JSON.stringify({ ...badStatus, status: "?" }));
    expect(await store.listThreads()).toEqual([good]);
    expect(entries.filter((e) => e.event === "store.threadUnreadable")).toHaveLength(3);
  });

  it("a thread directory without thread.json is skipped and logged, not deleted", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const orphan = "0b8f6a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b";
    await mkdir(path.join(threadsDir, orphan));
    expect(await store.listThreads()).toEqual([t]);
    expect(entries.filter((e) => e.event === "store.threadUnreadable")).toHaveLength(1);
    await expect(stat(path.join(threadsDir, orphan))).resolves.toBeTruthy();
  });

  it("non-UUID directories and stray files are ignored", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await mkdir(path.join(threadsDir, "notes"));
    await writeFile(path.join(threadsDir, "notes", "thread.json"), JSON.stringify({ ...t, id: "notes" }));
    await mkdir(path.join(threadsDir, t.id.toUpperCase().replace(/^./, "Z")));
    await writeFile(path.join(threadsDir, "README.txt"), "x");
    expect(await store.listThreads()).toEqual([t]);
    expect(entries.filter((e) => e.level === "warn" || e.level === "error")).toEqual([]);
  });
});

describe("getThread / screenshotPath", () => {
  const bad = [
    "..",
    "../x",
    "..\\x",
    "abc",
    "",
    "6F1C2D3E-4A5B-4C6D-8E7F-001122334455",
    "6f1c2d3e-4a5b-4c6d-8e7f-001122334455/..",
    "6f1c2d3e-4a5b-4c6d-8e7f-001122334455\\..\\..",
  ];

  it("getThread returns the saved thread", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    expect(await store.getThread(t.id)).toEqual(t);
  });

  it("getThread rejects .., non-UUID and unknown ids with threadNotFound", async () => {
    const store = makeStore();
    await store.createThread({ model: "opus", effort: "high" });
    for (const id of bad) await expectKind(store.getThread(id), "threadNotFound");
    await expectKind(store.getThread("6f1c2d3e-4a5b-4c6d-8e7f-001122334455"), "threadNotFound");
  });

  it("screenshotPath maps n to NNN.png inside the thread dir", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    expect(store.screenshotPath(t.id, 1)).toBe(path.join(threadsDir, t.id, "001.png"));
    expect(store.screenshotPath(t.id, 12)).toBe(path.join(threadsDir, t.id, "012.png"));
    expect(store.screenshotPath(t.id, 999)).toBe(path.join(threadsDir, t.id, "999.png"));
  });

  it("screenshotPath rejects .., non-UUID ids and out-of-range n", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    for (const id of bad) expect(() => store.screenshotPath(id, 1), id).toThrow(expect.objectContaining({ kind: "threadNotFound" }));
    for (const n of [0, -1, 1.5, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.screenshotPath(t.id, n), String(n)).toThrow(expect.objectContaining({ name: "SnapsolveError" }));
    }
  });
});

describe("adoptTranscript", () => {
  async function placeTranscript(sid: string, bytes: Buffer): Promise<string> {
    await mkdir(path.join(projectsDir, "C--other-project"), { recursive: true });
    await writeFile(path.join(projectsDir, "C--other-project", "unrelated.jsonl"), "{}\n");
    const dir = path.join(projectsDir, "C--Users-x-AppData-Local-snapsolve-sessions");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    await writeFile(file, bytes);
    return file;
  }
  const TRANSCRIPT = Buffer.concat([
    Buffer.from('{"type":"user","message":"é ∑ 漢字"}\r\n{"type":"assistant"}\n'),
    Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xff]),
  ]);

  it("copies <projectsDir>/*/<sid>.jsonl byte-identical into the thread dir, deletes the original, sets transcriptPath", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const original = await placeTranscript(t.sessionId, TRANSCRIPT);
    const owned = path.join(threadsDir, t.id, `${t.sessionId}.jsonl`);
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual({ ok: true, transcriptPath: owned });
    expect(await readFile(owned)).toEqual(TRANSCRIPT);
    await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readThreadJson(t.id)).transcriptPath).toBe(owned);
    expect((await readdir(path.join(threadsDir, t.id))).sort()).toEqual([`${t.sessionId}.jsonl`, "thread.json"]);
    expect(await readFile(path.join(projectsDir, "C--other-project", "unrelated.jsonl"), "utf8")).toBe("{}\n");
  });

  it("adopting again is a no-op that reports the owned copy", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await placeTranscript(t.sessionId, TRANSCRIPT);
    const first = await store.adoptTranscript(t.id, t.sessionId);
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual(first);
    expect((await readThreadJson(t.id)).transcriptMissing).toBeFalsy();
  });

  it("missing transcript → { ok: false }, the thread is marked, no throw", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const r = await store.adoptTranscript(t.id, t.sessionId);
    expect(r.ok).toBe(false);
    const saved = await readThreadJson(t.id);
    expect(saved.transcriptMissing).toBe(true);
    expect(saved.transcriptPath).toBeNull();
    expect(entries.some((e) => e.level === "warn" && e.event === "store.transcriptMissing")).toBe(true);
  });

  it("no projects directory at all → { ok: false }, no throw", async () => {
    const store = makeStore({ projectsDir: path.join(root, "nowhere") });
    const t = await store.createThread({ model: "opus", effort: "high" });
    expect((await store.adoptTranscript(t.id, t.sessionId)).ok).toBe(false);
    expect((await readThreadJson(t.id)).transcriptMissing).toBe(true);
  });

  it("a failed copy → { ok: false }, the original is kept, no temp file, the thread is marked", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const original = await placeTranscript(t.sessionId, TRANSCRIPT);
    vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error("no space"), { code: "ENOSPC" }));
    expect((await store.adoptTranscript(t.id, t.sessionId)).ok).toBe(false);
    expect(await readFile(original)).toEqual(TRANSCRIPT);
    expect(await readdir(path.join(threadsDir, t.id))).toEqual(["thread.json"]);
    expect(await readThreadJson(t.id)).toMatchObject({ transcriptPath: null, transcriptMissing: true });
  });

  it("a transient EBUSY on the transcript rename still adopts", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const original = await placeTranscript(t.sessionId, TRANSCRIPT);
    const owned = path.join(threadsDir, t.id, `${t.sessionId}.jsonl`);
    vi.mocked(fsp.rename).mockRejectedValueOnce(errno("EBUSY"));
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual({ ok: true, transcriptPath: owned });
    expect(await readFile(owned)).toEqual(TRANSCRIPT);
    await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await readThreadJson(t.id);
    expect(saved.transcriptPath).toBe(owned);
    expect(saved.transcriptMissing).toBeFalsy();
    expect((await readdir(path.join(threadsDir, t.id))).sort()).toEqual([`${t.sessionId}.jsonl`, "thread.json"]);
  });

  it("a sid that is not this thread's session id is refused and touches nothing", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const other = "0b8f6a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b";
    const original = await placeTranscript(other, TRANSCRIPT);
    await expect(store.adoptTranscript(t.id, other)).rejects.toMatchObject({ name: "SnapsolveError" });
    await expect(store.adoptTranscript(t.id, "../../escape")).rejects.toMatchObject({ name: "SnapsolveError" });
    expect(await readFile(original)).toEqual(TRANSCRIPT);
    expect(await readThreadJson(t.id)).toEqual(t);
  });
});

describe("adoptTranscript: the projects scan (task 046)", () => {
  const actualStat = async (file: string) => (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).stat(file);

  it("200 project dirs, the transcript in one → found, with stats in flight concurrently but never more than 32", async () => {
    const t0 = makeStore();
    const t = await t0.createThread({ model: "opus", effort: "high" });
    for (let i = 0; i < 200; i++) await mkdir(path.join(projectsDir, `p${String(i).padStart(3, "0")}`));
    const original = path.join(projectsDir, "p137", `${t.sessionId}.jsonl`);
    await writeFile(original, "{}\n");

    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const stat = vi.fn(async (file: string) => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await actualStat(file);
      } finally {
        inFlight--;
      }
    });
    const store = makeStore({ stat });
    const owned = path.join(threadsDir, t.id, `${t.sessionId}.jsonl`);
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual({ ok: true, transcriptPath: owned });
    expect(calls).toBeGreaterThanOrEqual(200);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
    await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("two matches → the newer mtime wins and store.transcriptDuplicates names both", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    const older = path.join(projectsDir, "a-older", `${t.sessionId}.jsonl`);
    const newer = path.join(projectsDir, "z-newer", `${t.sessionId}.jsonl`);
    for (const [file, text, when] of [
      [newer, "newer\n", new Date("2026-10-14T09:00:00Z")],
      [older, "older\n", new Date("2026-10-14T08:00:00Z")],
    ] as const) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      await utimes(file, when, when);
    }
    const owned = path.join(threadsDir, t.id, `${t.sessionId}.jsonl`);
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual({ ok: true, transcriptPath: owned });
    expect(await readFile(owned, "utf8")).toBe("newer\n");
    const dup = entries.find((e) => e.event === "store.transcriptDuplicates");
    expect(dup?.level).toBe("warn");
    expect([...(dup?.fields?.files as string[])].sort()).toEqual([older, newer].sort());
  });

  it("a file in projects and dirs without the transcript are ignored; no match → marked missing, no duplicates warning", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await writeFile(path.join(projectsDir, `${t.sessionId}.jsonl`), "a file directly in projects\n");
    await mkdir(path.join(projectsDir, "empty"));
    await mkdir(path.join(projectsDir, "other"));
    await writeFile(path.join(projectsDir, "other", "unrelated.jsonl"), "{}\n");
    await mkdir(path.join(projectsDir, "dir-named-like", `${t.sessionId}.jsonl`), { recursive: true });
    const r = await store.adoptTranscript(t.id, t.sessionId);
    expect(r).toEqual({ ok: false, reason: "transcript not found" });
    expect((await readThreadJson(t.id)).transcriptMissing).toBe(true);
    expect(entries.some((e) => e.event === "store.transcriptDuplicates")).toBe(false);
  });

  it("projects dir missing → not found, no store.projectsUnreadable warning", async () => {
    const store = makeStore({ projectsDir: path.join(root, "nowhere") });
    const t = await store.createThread({ model: "opus", effort: "high" });
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual({ ok: false, reason: "transcript not found" });
    expect(entries.some((e) => e.event === "store.projectsUnreadable")).toBe(false);
  });

  it("projects path unreadable (a file, ENOTDIR) → not found and store.projectsUnreadable logged", async () => {
    const notADir = path.join(root, "claude", "projects-file");
    await writeFile(notADir, "x");
    const store = makeStore({ projectsDir: notADir });
    const t = await store.createThread({ model: "opus", effort: "high" });
    expect(await store.adoptTranscript(t.id, t.sessionId)).toEqual({ ok: false, reason: "transcript not found" });
    const warn = entries.find((e) => e.event === "store.projectsUnreadable");
    expect(warn?.level).toBe("warn");
    expect(warn?.fields?.dir).toBe(notADir);
  });
});

describe("replaceSession", () => {
  it("swaps sessionId and clears transcriptPath, keeps turns and the old transcript file", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await writeFile(path.join(projectsDir, "x.jsonl"), "");
    await mkdir(path.join(projectsDir, "p"));
    await writeFile(path.join(projectsDir, "p", `${t.sessionId}.jsonl`), "old\n");
    await store.adoptTranscript(t.id, t.sessionId);
    await store.appendTurn(t.id, userText("q"));
    await store.appendTurn(t.id, answer("a"));
    const newSid = "0b8f6a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b";
    const r = await store.replaceSession(t.id, newSid);
    expect(r.sessionId).toBe(newSid);
    expect(r.transcriptPath).toBeNull();
    expect(r.turns).toEqual([userText("q"), answer("a")]);
    expect(await readThreadJson(t.id)).toEqual(r);
    expect(await readFile(path.join(threadsDir, t.id, `${t.sessionId}.jsonl`), "utf8")).toBe("old\n");
  });

  it("clears the missing-transcript mark, and generates a fresh UUID when none is given", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await store.adoptTranscript(t.id, t.sessionId);
    const r = await store.replaceSession(t.id);
    expect(r.sessionId).toMatch(UUID_V4);
    expect(r.sessionId).not.toBe(t.sessionId);
    expect(r.transcriptMissing).toBeFalsy();
    expect((await readThreadJson(t.id)).transcriptMissing).toBeFalsy();
  });

  it("rejects a non-UUID session id", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await expect(store.replaceSession(t.id, "../x")).rejects.toMatchObject({ name: "SnapsolveError" });
    expect(await readThreadJson(t.id)).toEqual(t);
  });
});

describe("clearHistory", () => {
  it("removes threads/, then calls purge(sessionsDir); the list is empty after", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    await store.saveScreenshot(t.id, PNG);
    purge.mockImplementation(async () => {
      await expect(stat(path.join(threadsDir, t.id))).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(await store.clearHistory()).toEqual({ ok: true });
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(sessionsDir);
    expect(await store.listThreads()).toEqual([]);
    await expect(stat(path.join(threadsDir, t.id))).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = await store.createThread({ model: "opus", effort: "high" });
    expect(await store.listThreads()).toEqual([fresh]);
  });

  it("a purge failure is logged and returned, but threads are still deleted", async () => {
    const store = makeStore();
    const t = await store.createThread({ model: "opus", effort: "high" });
    purge.mockRejectedValueOnce(new Error("claude purge exited 1"));
    const r = await store.clearHistory();
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error");
    expect(entries.some((e) => e.level === "error" && e.event === "store.purgeFailed")).toBe(true);
    await expect(stat(path.join(threadsDir, t.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.listThreads()).toEqual([]);
  });

  it("works with no threads/ directory", async () => {
    expect(await makeStore().clearHistory()).toEqual({ ok: true });
    expect(purge).toHaveBeenCalledWith(sessionsDir);
  });
});
