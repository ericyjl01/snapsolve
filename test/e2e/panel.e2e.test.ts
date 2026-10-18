import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { CONTINUED_NOTE } from "../../src/shared/errors";
import { fixturesDir } from "../paths";
import { launchApp, type LaunchedApp } from "./helpers";

const FAKE = path.join(fixturesDir, "fake-claude.mjs");
const PROBLEM = path.join(fixturesDir, "problems", "algebra.png");
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' snapsolve:; " +
  "connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
// SPEC §4.4's nine plus Amendment 2's two (task 030).
const PRELOAD_NAMES = [
  "onDelta",
  "onDone",
  "onThreadsChanged",
  "listThreads",
  "followUp",
  "retry",
  "copy",
  "openExternal",
  "clearHistory",
  "openScreenRecordingSettings",
  "relaunch",
];

interface Panel extends LaunchedApp {
  page: Page;
}

/** The built app in test mode, its claude the fake (slow: ~500 ms before each answer piece), answers ending in math. */
async function launchPanel(dataDir?: string): Promise<Panel> {
  const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
  const launched = await launchApp({
    dataDir,
    env: {
      SNAPSOLVE_TEST_CLAUDE: FAKE,
      SNAPSOLVE_TEST_PROJECTS: projects,
      FAKE_PROJECTS: projects,
      FAKE_CLAUDE_SCENARIO: "slow",
      FAKE_DELAY_MS: "1500",
      FAKE_ANSWER_SUFFIX: " So $x = \\sqrt{16}$.",
    },
  });
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return {
    ...launched,
    page,
    close: async () => {
      await launched.close();
      rmSync(projects, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

async function windowInfo(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const [win] = BrowserWindow.getAllWindows();
    const bounds = win.getBounds();
    return {
      count: BrowserWindow.getAllWindows().length,
      bounds,
      visible: win.isVisible(),
      focused: win.isFocused(),
      contentProtected: win.isContentProtected(),
      alwaysOnTop: win.isAlwaysOnTop(),
      workArea: screen.getDisplayMatching(bounds).workArea,
    };
  });
}

function capture(app: ElectronApplication): Promise<string> {
  return app.evaluate(
    (_electron, png) => (globalThis as unknown as { snapsolveTest: { captureFromFile(p: string): Promise<string> } }).snapsolveTest.captureFromFile(png),
    PROBLEM,
  );
}

const card = (id: string) => `[data-thread-id="${id}"]`;

describe("panel (e2e)", () => {
  it("captureFromFile opens the panel unfocused with Thinking…, streams a rendered answer, and a follow-up adds a second answer", async () => {
    const p = await launchPanel();
    try {
      const id = await capture(p.app);
      const thinking = p.page.locator(`${card(id)} .thinking`);
      await thinking.waitFor({ state: "visible", timeout: 5_000 });
      expect(await p.page.locator(`${card(id)} .answer`).count()).toBe(0);

      await expect.poll(async () => (await windowInfo(p.app)).bounds.width, { timeout: 5_000 }).toBe(360);
      const info = await windowInfo(p.app);
      expect(info.count).toBe(1);
      expect(info.visible).toBe(true);
      expect(info.focused).toBe(false);
      expect(info.alwaysOnTop).toBe(true);
      // The floating window's first open (058): 360 × 460, 24 px in from the work area's right and top.
      expect(info.bounds).toEqual({
        x: info.workArea.x + info.workArea.width - 24 - 360,
        y: info.workArea.y + 24,
        width: 360,
        height: 460,
      });

      // The thumbnail comes through snapsolve://thread/<id>/1.png and actually loads.
      const thumb = p.page.locator(`${card(id)} img.thumb`).first();
      expect(await thumb.getAttribute("src")).toBe(`snapsolve://thread/${id}/1.png`);
      await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 5_000 }).toBeGreaterThan(0);

      await p.page.locator(`${card(id)} .answer .katex`).first().waitFor({ state: "visible", timeout: 20_000 });
      await expect.poll(() => thinking.count(), { timeout: 5_000 }).toBe(0);
      expect(await p.page.locator(`${card(id)} .answer`).first().innerText()).toContain("Answer 1: saw 1 image(s).");

      const box = p.page.locator(`${card(id)} textarea.follow-up`);
      await box.fill("Why is it 4?");
      await box.press("Enter");
      await expect.poll(() => p.page.locator(`${card(id)} .answer`).count(), { timeout: 20_000 }).toBe(2);
      await p.page.locator(`${card(id)} .answer`).nth(1).locator(".katex").first().waitFor({ state: "visible", timeout: 20_000 });
      expect(await p.page.locator(`${card(id)} .answer`).nth(1).innerText()).toContain("Answer 2: saw 0 image(s).");
      expect(await p.page.locator(`${card(id)} .question`).allInnerTexts()).toContain("Why is it 4?");
      expect(await p.page.locator("[data-thread-id]").count()).toBe(1);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("is content-protected, has the CSP meta, denies window.open and exposes exactly the eleven preload functions", async () => {
    const p = await launchPanel();
    try {
      expect((await windowInfo(p.app)).contentProtected).toBe(true);
      expect(await p.page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toBe(CSP);
      expect(await p.page.evaluate(() => window.open("https://example.com/") === null)).toBe(true);
      expect(await p.page.evaluate(() => Object.keys((window as unknown as { snapsolve: object }).snapsolve).sort())).toEqual(
        [...PRELOAD_NAMES].sort(),
      );
      expect(await p.page.evaluate(() => [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process])).toEqual([
        "undefined",
        "undefined",
      ]);
      expect(p.page.url()).toMatch(/^snapsolve:\/\/app\//);
      // Navigation away is prevented.
      await p.page.evaluate(() => {
        location.href = "https://example.com/";
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(p.page.url()).toMatch(/^snapsolve:\/\/app\//);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("stays open 2 s after the answer with autoHideSec 0, has no × button, and Esc after clicking in hides it with nothing left on screen", async () => {
    const p = await launchPanel();
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer .katex`).first().waitFor({ state: "visible", timeout: 20_000 });
      await expect.poll(() => p.page.locator(`${card(id)} .thinking`).count(), { timeout: 5_000 }).toBe(0);
      await new Promise((r) => setTimeout(r, 2_000));
      expect((await windowInfo(p.app)).bounds.width).toBe(360);

      expect(await p.page.evaluate(() => document.body.innerText.includes("×"))).toBe(false);
      expect(await p.page.locator('button.close, [aria-label*="close" i], [title*="close" i]').count()).toBe(0);

      await p.page.locator(`${card(id)} .answer`).first().click();
      // A real key press reaches main's before-input-event; Playwright's keyboard (CDP) bypasses it, so the key is
      // delivered the way the OS delivers it to the focused window.
      await p.app.evaluate(({ BrowserWindow }) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      });
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);
      expect(await p.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("an append past maxScreenshotsPerThread opens a new card that says it continues the previous thread, its claude given the last answer (051)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
    const fakeLog = path.join(projects, "fake.log");
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ maxScreenshotsPerThread: 1 }));
    const launched = await launchApp({
      dataDir,
      env: { SNAPSOLVE_TEST_CLAUDE: FAKE, SNAPSOLVE_TEST_PROJECTS: projects, FAKE_PROJECTS: projects, FAKE_LOG: fakeLog },
    });
    try {
      const page = await launched.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const first = await capture(launched.app);
      // The saved answer, not the streaming node (also `.answer`): an append before it is saved seeds nothing (051).
      await page.locator(`${card(first)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });
      expect(await page.locator(`${card(first)} .note`).count()).toBe(0);

      const next = await launched.app.evaluate(
        (_electron, png) =>
          (globalThis as unknown as { snapsolveTest: { appendFromFile(p: string): Promise<string> } }).snapsolveTest.appendFromFile(png),
        PROBLEM,
      );
      expect(next).not.toBe(first);
      const note = page.locator(`${card(next)} .note`);
      await note.waitFor({ state: "visible", timeout: 10_000 });
      expect(await note.textContent()).toBe(CONTINUED_NOTE);
      await page.locator(`${card(next)} .answer`).first().waitFor({ state: "visible", timeout: 20_000 });
      expect(await page.locator("[data-thread-id]").count()).toBe(2);

      const starts = readFileSync(fakeLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; stdin?: { message: { content: { type: string; text?: string }[] } } })
        .filter((e) => e.event === "start");
      expect(starts).toHaveLength(2);
      const texts = starts[1].stdin?.message.content.filter((b) => b.type === "text").map((b) => b.text) ?? [];
      expect(texts.join("\n")).toContain("Answer 1: saw 1 image(s).");
    } finally {
      await launched.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      rmSync(projects, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);

  it("the continued note shows while the seeded thread's answer is still pending, not only once it is done (057)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
    const scenarioFile = path.join(projects, "scenario");
    writeFileSync(scenarioFile, "ok");
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ maxScreenshotsPerThread: 1 }));
    const launched = await launchApp({
      dataDir,
      env: {
        SNAPSOLVE_TEST_CLAUDE: FAKE,
        SNAPSOLVE_TEST_PROJECTS: projects,
        FAKE_PROJECTS: projects,
        FAKE_CLAUDE_SCENARIO_FILE: scenarioFile,
        // The seeded turn's answer is held back for ~20 s, far past the note's wait.
        FAKE_DELAY_MS: "20000",
      },
    });
    try {
      const page = await launched.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const first = await capture(launched.app);
      // The saved answer, not the streaming node (also `.answer`): an append before it is saved seeds nothing (051).
      await page.locator(`${card(first)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });

      writeFileSync(scenarioFile, "slow");
      const next = await launched.app.evaluate(
        (_electron, png) =>
          (globalThis as unknown as { snapsolveTest: { appendFromFile(p: string): Promise<string> } }).snapsolveTest.appendFromFile(png),
        PROBLEM,
      );
      expect(next).not.toBe(first);
      const note = page.locator(`${card(next)} .note`);
      await note.waitFor({ state: "visible", timeout: 5_000 });
      expect(await note.textContent()).toBe(CONTINUED_NOTE);
      expect(await page.locator(`${card(next)} .answer:not(.streaming)`).count()).toBe(0);
    } finally {
      await launched.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      rmSync(projects, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);

  it("a thread left running by an earlier run is listed errored with Retry at startup, and its thread.json says error (052)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    const id = "7d0c5a1e-2b3f-4c6d-8e9f-0a1b2c3d4e5f";
    const dir = path.join(dataDir, "threads", id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(PROBLEM, path.join(dir, "001.png"));
    writeFileSync(
      path.join(dir, "thread.json"),
      JSON.stringify({
        id,
        sessionId: "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b",
        transcriptPath: null,
        model: "opus",
        effort: "high",
        createdAt: new Date().toISOString(),
        title: "",
        status: "running",
        turns: [{ role: "user", kind: "screenshot", file: "001.png" }],
      }),
    );
    const launched = await launchApp({ dataDir, env: { SNAPSOLVE_TEST_CLAUDE: FAKE } });
    try {
      const page = await launched.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const retry = page.locator(`${card(id)} .retry`);
      await retry.waitFor({ state: "visible", timeout: 10_000 });
      expect(await page.locator(`${card(id)} .thinking`).count()).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, "thread.json"), "utf8")).status).toBe("error");
    } finally {
      await launched.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);

  it("title bar drag moves the window: movable, a 36 px drag-region title bar, and it reopens at the new x/y, also after a restart (058)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-window-"));
    const stateFile = path.join(dataDir, "window.json");
    try {
      let p = await launchPanel(dataDir);
      let target = { x: 0, y: 0 };
      let displayId = 0;
      try {
        expect(await p.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMovable())).toBe(true);
        const bar = p.page.locator("#titlebar");
        expect(await bar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"))).toBe("drag");

        await capture(p.app);
        await expect.poll(async () => (await windowInfo(p.app)).bounds.width, { timeout: 5_000 }).toBe(360);
        expect((await bar.boundingBox())?.height).toBe(36);
        const { workArea } = await windowInfo(p.app);
        target = { x: workArea.x + 100, y: workArea.y + 120 };
        // The title bar drag itself is the window server's (no synthetic input reaches it): move the window the way a
        // drag ends, a new position then Electron's `moved`.
        displayId = await p.app.evaluate(({ BrowserWindow, screen }, to) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.setPosition(to.x, to.y);
          win.emit("moved");
          return screen.getDisplayMatching(win.getBounds()).id;
        }, target);
        await expect
          .poll(() => {
            try {
              return JSON.parse(readFileSync(stateFile, "utf8")).displays[String(displayId)];
            } catch {
              return null;
            }
          }, { timeout: 5_000 })
          .toEqual({ ...target, width: 360, height: 460 });

        // Collapse (Esc in the focused window), then the next capture reopens where it was left.
        await p.page.locator("#threads").click();
        await p.app.evaluate(({ BrowserWindow }) => {
          const { webContents } = BrowserWindow.getAllWindows()[0];
          webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        });
        await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);
        await capture(p.app);
        await expect.poll(async () => (await windowInfo(p.app)).bounds, { timeout: 5_000 }).toEqual({ ...target, width: 360, height: 460 });
      } finally {
        await p.close();
      }

      p = await launchPanel(dataDir);
      try {
        await capture(p.app);
        await expect.poll(async () => (await windowInfo(p.app)).bounds, { timeout: 5_000 }).toEqual({ ...target, width: 360, height: 460 });
      } finally {
        await p.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 120_000);

  it("resized window reopens at the new size: resizable with a 280 × 300 minimum while open, the size saved per display (059)", async () => {
    const p = await launchPanel();
    const stateFile = path.join(p.dataDir, "window.json");
    try {
      await capture(p.app);
      await expect.poll(async () => (await windowInfo(p.app)).bounds.width, { timeout: 5_000 }).toBe(360);
      await p.page.locator(".grip").waitFor({ state: "attached", timeout: 5_000 });
      expect(await p.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return { resizable: win.isResizable(), minimum: win.getMinimumSize() };
      })).toEqual({ resizable: true, minimum: [280, 300] });

      // An edge drag is the window server's: resize the way one ends, new bounds then Electron's `resized`.
      const { workArea } = await windowInfo(p.app);
      const target = { x: workArea.x + 80, y: workArea.y + 60, width: 500, height: 600 };
      const displayId = await p.app.evaluate(({ BrowserWindow, screen }, to) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds(to);
        win.emit("resized");
        return screen.getDisplayMatching(win.getBounds()).id;
      }, target);
      await expect
        .poll(() => {
          try {
            return JSON.parse(readFileSync(stateFile, "utf8")).displays[String(displayId)];
          } catch {
            return null;
          }
        }, { timeout: 5_000 })
        .toEqual(target);

      // The OS keeps it at or above the minimum.
      const small = await p.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(200, 200);
        return win.getSize();
      });
      expect(small[0]).toBeGreaterThanOrEqual(280);
      expect(small[1]).toBeGreaterThanOrEqual(300);
      await p.app.evaluate(({ BrowserWindow }, to) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds(to);
        win.emit("resized");
      }, target);

      // Hide (Esc), then the next capture reopens at the saved size.
      await p.page.locator("#threads").click();
      await p.app.evaluate(({ BrowserWindow }) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      });
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);
      await capture(p.app);
      await expect.poll(async () => (await windowInfo(p.app)).bounds, { timeout: 5_000 }).toEqual(target);
    } finally {
      await p.close();
    }
  }, 120_000);

  it("toggle hides with nothing visible, then restores at the same bounds without taking focus (060)", async () => {
    const p = await launchPanel();
    const toggle = () => p.app.evaluate(() => (globalThis as unknown as { snapsolveTest: { toggle(): void } }).snapsolveTest.toggle());
    try {
      expect((await windowInfo(p.app)).visible).toBe(false);
      await toggle();
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(true);
      const shown = await windowInfo(p.app);
      expect(shown.focused).toBe(false);
      expect(shown.bounds).toEqual({ x: shown.workArea.x + shown.workArea.width - 24 - 360, y: shown.workArea.y + 24, width: 360, height: 460 });

      await toggle();
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);
      expect(await p.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);

      await toggle();
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(true);
      const again = await windowInfo(p.app);
      expect(again.bounds).toEqual(shown.bounds);
      expect(again.focused).toBe(false);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("a denied Screen Recording capture shows the permission card with its buttons and no Retry", async () => {
    const p = await launchPanel();
    try {
      const deny = (prompted: boolean) =>
        p.app.evaluate(
          (_electron, value) =>
            (globalThis as unknown as { snapsolveTest: { denyCapture(prompted: boolean): Promise<void> } }).snapsolveTest.denyCapture(value),
          prompted,
        );
      await deny(false);
      const permission = p.page.locator(".card.permission");
      await permission.waitFor({ state: "visible", timeout: 5_000 });
      expect(await p.page.locator(".card.permission").count()).toBe(1);
      expect(await permission.locator(".error").textContent()).toBe(
        "snapsolve needs Screen Recording permission. Grant it in System Settings, then relaunch.",
      );
      expect(await permission.locator("button.open-settings").isVisible()).toBe(true);
      expect(await permission.locator("button.relaunch").isVisible()).toBe(true);
      expect(await permission.locator(".retry").isVisible()).toBe(false);
      expect(await permission.locator("textarea, input").count()).toBe(0);
      expect(await permission.locator("img").count()).toBe(0);

      await deny(true);
      await expect
        .poll(() => permission.locator(".error").textContent(), { timeout: 5_000 })
        .toBe("Grant Screen Recording in the prompt, then click Relaunch.");
      expect(await p.page.locator(".card.permission").count()).toBe(1);
      expect(await permission.locator("button.open-settings").count()).toBe(0);
      expect(await permission.locator("button.relaunch").isVisible()).toBe(true);
    } finally {
      await p.close();
    }
  });
});
