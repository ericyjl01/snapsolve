import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication } from "playwright-core";
import { describe, expect, it } from "vitest";
import { fixturesDir, repoRoot } from "../paths";
import { launchApp, type LaunchedApp } from "./helpers";

const FAKE = path.join(fixturesDir, "fake-claude.mjs");
const PROBLEM = path.join(fixturesDir, "problems", "algebra.png");
const ELECTRON = createRequire(path.join(repoRoot, "package.json"))("electron") as string;

interface Launched extends LaunchedApp {
  projects: string;
}

async function launch(): Promise<Launched> {
  const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
  const launched = await launchApp({
    env: { SNAPSOLVE_TEST_CLAUDE: FAKE, SNAPSOLVE_TEST_PROJECTS: projects, FAKE_PROJECTS: projects, FAKE_CLAUDE_SCENARIO: "ok" },
  });
  await launched.app.firstWindow();
  return {
    ...launched,
    projects,
    close: async () => {
      await launched.close();
      rmSync(projects, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** Starts another `electron dist/main.js` on the same data dir (so the same single-instance lock); resolves with its exit code. */
function secondInstance(dataDir: string, args: string[] = [], timeoutMs = 15_000): Promise<number | null | "timeout"> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { SNAPSOLVE_TEST: "1", SNAPSOLVE_DATA_DIR: dataDir });
  const child = spawn(ELECTRON, [path.join(repoRoot, "dist", "main.js"), ...args], { env, cwd: repoRoot, stdio: "ignore" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function exitOf(app: ElectronApplication, timeoutMs: number): Promise<number | null | "timeout"> {
  const child = app.process();
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const panelVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());

type TestHooks = {
  hotkeyStatus(): { capture: boolean; append: boolean; toggle: boolean; paused: boolean };
  captureFromFile(png: string): Promise<string>;
  appendFromFile(png: string): Promise<string>;
};

describe("app lifecycle (e2e)", () => {
  it("a second launch with --quit makes the first instance exit 0 within 10 s", async () => {
    const first = await launch();
    try {
      const exited = exitOf(first.app, 10_000);
      expect(await secondInstance(first.dataDir, ["--quit"])).toBe(0);
      expect(await exited).toBe(0);
    } finally {
      await first.close();
    }
  }, 60_000);

  it("a second launch without arguments opens the first instance's panel and exits itself", async () => {
    const first = await launch();
    try {
      // Hidden at startup (060: no tab); the second launch shows it.
      expect(await panelVisible(first.app)).toBe(false);
      expect(await secondInstance(first.dataDir)).toBe(0);
      await expect.poll(() => panelVisible(first.app), { timeout: 5_000 }).toBe(true);
      expect(first.app.process().exitCode).toBeNull();
    } finally {
      await first.close();
    }
  }, 60_000);

  it("--quit with no instance running exits 0 without starting the app", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-quit-"));
    try {
      expect(await secondInstance(dataDir, ["--quit"], 10_000)).toBe(0);
      expect(existsSync(path.join(dataDir, "threads"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);

  it("the three hotkeys are registered at startup", async () => {
    const first = await launch();
    try {
      const status = await first.app.evaluate(() => (globalThis as unknown as { snapsolveTest: TestHooks }).snapsolveTest.hotkeyStatus());
      expect(status).toEqual({ capture: true, append: true, toggle: true, paused: false });
      const registered = await first.app.evaluate(({ globalShortcut }) => [
        globalShortcut.isRegistered("Control+Alt+Q"),
        globalShortcut.isRegistered("Control+Alt+Shift+Q"),
        globalShortcut.isRegistered("Control+Alt+X"),
      ]);
      expect(registered).toEqual([true, true, true]);
    } finally {
      await first.close();
    }
  }, 60_000);

  it("appendFromFile adds a screenshot to the most recent capture's thread", async () => {
    const first = await launch();
    try {
      const hooks = (fn: string) =>
        first.app.evaluate(
          (_e, [name, png]) => (globalThis as unknown as { snapsolveTest: Record<string, (p: string) => Promise<string>> }).snapsolveTest[name](png),
          [fn, PROBLEM] as const,
        );
      const older = await hooks("captureFromFile");
      const latest = await hooks("captureFromFile");
      const appended = await hooks("appendFromFile");
      expect(appended).toBe(latest);
      expect(appended).not.toBe(older);
      const dir = path.join(first.dataDir, "threads", latest);
      expect(existsSync(path.join(dir, "002.png"))).toBe(true);
      expect(existsSync(path.join(first.dataDir, "threads", older, "002.png"))).toBe(false);
      await expect
        .poll(
          () => {
            const thread = JSON.parse(readFileSync(path.join(dir, "thread.json"), "utf8")) as { status: string; turns: { role: string; kind?: string; file?: string }[] };
            return { status: thread.status, shots: thread.turns.filter((t) => t.kind === "screenshot").map((t) => t.file) };
          },
          { timeout: 20_000 },
        )
        .toEqual({ status: "done", shots: ["001.png", "002.png"] });
    } finally {
      await first.close();
    }
  }, 60_000);
});
