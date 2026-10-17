import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
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
async function launchPanel(): Promise<Panel> {
  const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
  const launched = await launchApp({
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

      await expect.poll(async () => (await windowInfo(p.app)).bounds.width, { timeout: 5_000 }).toBe(420);
      const info = await windowInfo(p.app);
      expect(info.count).toBe(1);
      expect(info.visible).toBe(true);
      expect(info.focused).toBe(false);
      expect(info.alwaysOnTop).toBe(true);
      expect(info.bounds).toEqual({
        x: info.workArea.x + info.workArea.width - 420,
        y: info.workArea.y,
        width: 420,
        height: info.workArea.height,
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

  it("stays open 2 s after the answer with autoHideSec 0, has no × button, and Esc after clicking in collapses it to the tab", async () => {
    const p = await launchPanel();
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer .katex`).first().waitFor({ state: "visible", timeout: 20_000 });
      await expect.poll(() => p.page.locator(`${card(id)} .thinking`).count(), { timeout: 5_000 }).toBe(0);
      await new Promise((r) => setTimeout(r, 2_000));
      expect((await windowInfo(p.app)).bounds.width).toBe(420);

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
      await expect.poll(async () => (await windowInfo(p.app)).bounds.width, { timeout: 5_000 }).toBe(8);
      const { bounds, workArea, visible } = await windowInfo(p.app);
      expect(visible).toBe(true);
      expect(bounds).toEqual({ x: workArea.x + workArea.width - 8, y: workArea.y + Math.round((workArea.height - 72) / 2), width: 8, height: 72 });
    } finally {
      await p.close();
    }
  }, 90_000);

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
