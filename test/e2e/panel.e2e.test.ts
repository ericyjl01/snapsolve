import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { CONTINUED_NOTE } from "../../src/shared/errors";
import type { Thread } from "../../src/shared/types";
import { fixturesDir } from "../paths";
import { launchApp, type LaunchedApp } from "./helpers";

const FAKE = path.join(fixturesDir, "fake-claude.mjs");
const FAKE_SPEECH = path.join(fixturesDir, "fake-speech.mjs");
const PROBLEM = path.join(fixturesDir, "problems", "algebra.png");
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' snapsolve:; " +
  "connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
// SPEC §4.4's nine plus Amendment 2's two (task 030), with `copy` replaced by `hide` (Amendment 9, task 061), plus
// `newThread` (Amendment 10, task 065), plus voice's three (Amendment 11, task 063).
const PRELOAD_NAMES = [
  "onDelta",
  "onDone",
  "onThreadsChanged",
  "listThreads",
  "followUp",
  "retry",
  "newThread",
  "hide",
  "openExternal",
  "clearHistory",
  "openScreenRecordingSettings",
  "relaunch",
  "onVoice",
  "toggleVoice",
  "openVoiceSettings",
  "openThread",
];

interface Panel extends LaunchedApp {
  page: Page;
}

/** The built app in test mode, its claude the fake (slow: ~500 ms before each answer piece), answers ending in math. */
async function launchPanel(dataDir?: string, extraEnv: Record<string, string> = {}): Promise<Panel> {
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
      SNAPSOLVE_TEST_SPEECH: FAKE_SPEECH,
      ...extraEnv,
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

/** Relative luminance (WCAG) of a computed `rgb(…)`/`rgba(…)` color, 0 (black) to 1 (white). */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** What the voice hotkey does (063). */
function voiceKey(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as unknown as { snapsolveTest: { voice(): void } }).snapsolveTest.voice());
}

/** What Esc does while listening (063): the temporary global Escape shortcut's callback. */
function voiceEscape(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as unknown as { snapsolveTest: { voiceEscape(): void } }).snapsolveTest.voiceEscape());
}

function escapeRegistered(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("Escape"));
}

/** The title bar's "+" (065). */
async function newChat(page: Page): Promise<void> {
  await page.locator("#titlebar").getByRole("button", { name: "New chat" }).click();
}

/** The sidebar's chats (078), top to bottom. */
function chats(page: Page): Promise<(string | undefined)[]> {
  return page.locator("[data-chat-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.chatId));
}

/** The title bar's sidebar toggle while the sidebar is closed (078). */
async function showChats(page: Page): Promise<void> {
  await page.locator("#titlebar").getByRole("button", { name: "Show chats" }).click();
  await page.locator('nav[aria-label="Chats"]').waitFor({ state: "visible", timeout: 5_000 });
}

/** Opens the sidebar (narrow window) and chooses a chat (078). */
async function chooseChat(page: Page, id: string): Promise<void> {
  if (!(await page.locator('nav[aria-label="Chats"]').isVisible())) await showChats(page);
  await page.locator(`[data-chat-id="${id}"]`).click();
}

function setWindowWidth(app: ElectronApplication, width: number): Promise<void> {
  return app.evaluate(({ BrowserWindow }, w) => {
    const [win] = BrowserWindow.getAllWindows();
    const b = win.getBounds();
    win.setBounds({ ...b, width: w });
  }, width);
}

/** Resizes the window and waits until the page has laid out at the new width (082): a "still closed" check is then meaningful. */
async function resizeTo(p: { app: ElectronApplication; page: Page }, width: number): Promise<void> {
  await setWindowWidth(p.app, width);
  await expect.poll(() => p.page.evaluate(() => window.innerWidth), { timeout: 5_000 }).toBe(width);
  await p.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** A finished thread on disk (thread.json only), created at `createdAt` (078 grouping fixtures). */
function writeThread(dataDir: string, id: string, title: string, createdAt: Date): void {
  const dir = path.join(dataDir, "threads", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "thread.json"),
    JSON.stringify({
      id,
      sessionId: id,
      transcriptPath: null,
      model: "opus",
      effort: "high",
      createdAt: createdAt.toISOString(),
      title,
      status: "done",
      turns: [
        { role: "user", kind: "text", text: `About ${title}` },
        { role: "assistant", text: `${title} answer`, durationMs: 1, ttftMs: null, costUsd: null, isError: false },
      ],
    }),
  );
}

/** Noon, local time, `days` days ago. */
function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(12, 0, 0, 0);
  return d;
}

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

      // No Copy (061): no button, and nothing to call.
      expect(await p.page.getByRole("button", { name: /copy/i }).count()).toBe(0);
      expect(await p.page.evaluate(() => "copy" in (window as unknown as { snapsolve: object }).snapsolve)).toBe(false);

      // The follow-up composer is the window's own, pinned below the list (061), not one box per card.
      expect(await p.page.locator(`${card(id)} textarea`).count()).toBe(0);
      expect(await p.page.locator(`${card(id)} .retry`).isVisible()).toBe(false);
      const box = p.page.locator("#composer textarea");
      const content = await p.page.locator("#content").boundingBox();
      const composer = await p.page.locator("#composer").boundingBox();
      expect(composer && content && composer.y >= content.y + content.height - 1).toBe(true);
      expect(composer && Math.round(composer.y + composer.height)).toBe(460);
      // Shift+Enter is a new line, not a send.
      await box.fill("Why");
      await box.press("Shift+Enter");
      expect(await box.inputValue()).toBe("Why\n");
      await new Promise((r) => setTimeout(r, 500));
      expect(await p.page.locator(`${card(id)} .question`).count()).toBe(0);
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

  it("is content-protected, has the CSP meta, denies window.open and exposes exactly the sixteen preload functions", async () => {
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

  it("stays open 2 s after the answer with autoHideSec 0, and Esc after clicking in hides it with nothing left on screen", async () => {
    const p = await launchPanel();
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer .katex`).first().waitFor({ state: "visible", timeout: 20_000 });
      await expect.poll(() => p.page.locator(`${card(id)} .thinking`).count(), { timeout: 5_000 }).toBe(0);
      await new Promise((r) => setTimeout(r, 2_000));
      expect((await windowInfo(p.app)).bounds.width).toBe(360);

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

  it("a capture with the window hidden shows it and the card's Thinking…; each capture logs capture.timing with all five fields (088)", async () => {
    const p = await launchPanel();
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer:not(.streaming)`).first().waitFor({ state: "attached", timeout: 20_000 });
      await expect.poll(() => p.page.locator(`${card(id)} .thinking`).count(), { timeout: 5_000 }).toBe(0);
      // Hidden the way the show/hide hotkey hides it.
      await p.app.evaluate(() => (globalThis as unknown as { snapsolveTest: { toggle(): void } }).snapsolveTest.toggle());
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);

      expect(await capture(p.app)).toBe(id);
      expect((await windowInfo(p.app)).visible).toBe(true);
      expect((await windowInfo(p.app)).focused).toBe(false);
      await p.page.locator(`${card(id)} .thinking`).waitFor({ state: "visible", timeout: 5_000 });

      const logFile = path.join(p.dataDir, "logs", "snapsolve.log");
      const timings = () =>
        readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.event === "capture.timing");
      await expect.poll(() => timings().length, { timeout: 5_000 }).toBe(2);
      for (const line of timings()) {
        for (const field of ["grabMs", "pngMs", "encodeMs", "saveMs", "shownMs"]) {
          expect(Number.isInteger(line[field]) && (line[field] as number) >= 0, `${field} = ${String(line[field])}`).toBe(true);
        }
      }
    } finally {
      await p.close();
    }
  }, 90_000);

  it("the title bar's × hides the window with nothing left on screen, and the next capture shows it again (061)", async () => {
    const p = await launchPanel();
    try {
      const id = await capture(p.app);
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(true);
      const hide = p.page.locator("#titlebar").getByRole("button", { name: "Hide window" });
      expect(await hide.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"))).toBe("no-drag");
      await hide.click();
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);
      expect(await p.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);

      await p.page.locator(`${card(id)} .answer:not(.streaming)`).first().waitFor({ state: "attached", timeout: 20_000 });
      await capture(p.app);
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(true);
    } finally {
      await p.close();
    }
  }, 90_000);

  // 083 (Amendment 17): the title bar's mark is the tray's symbol, crop corners framing an equals sign.
  it("the title bar's mark is four crop corners and two bars, stroked in currentColor and accent coloured (083)", async () => {
    const p = await launchPanel();
    try {
      const mark = p.page.locator("#titlebar svg.mark");
      const shape = await mark.evaluate((svg) => ({
        stroke: svg.getAttribute("stroke"),
        fill: svg.getAttribute("fill"),
        others: svg.querySelectorAll(":scope > :not(path)").length,
        paths: [...svg.querySelectorAll("path")].map((el) => el.getAttribute("d")),
      }));
      expect(shape.stroke).toBe("currentColor");
      expect(shape.fill).toBe("none");
      expect(shape.others).toBe(0);
      expect(shape.paths).toEqual([
        // Crop corners: top left, top right, bottom right, bottom left.
        "M2 6V2h4",
        "M10 2h4v4",
        "M14 10v4h-4",
        "M6 14H2v-4",
        // The equals sign's two bars.
        "M5 6.5h6",
        "M5 9.5h6",
      ]);
      const [color, accent, text] = await mark.evaluate((svg) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const resolved = [getComputedStyle(svg).color, getComputedStyle(probe).color, getComputedStyle(document.body).color];
        probe.remove();
        return resolved;
      });
      expect(color).toBe(accent);
      expect(color).not.toBe(text);
    } finally {
      await p.close();
    }
  }, 60_000);

  // 075: config.json theme drives the look whatever macOS uses (dark when unset); 076: the ground is ~88% solid,
  // see-through like a terminal with no blur (Amendment 13).
  it.each([
    { config: {}, dark: true, ground: "rgba(24, 24, 24, 0.88)" },
    { config: { theme: "dark" }, dark: true, ground: "rgba(24, 24, 24, 0.88)" },
    { config: { theme: "light" }, dark: false, ground: "rgba(246, 246, 248, 0.88)" },
  ])("theme $config → dark $dark, ground $ground (075, 076)", async ({ config, dark, ground }) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
    const p = await launchPanel(dataDir);
    try {
      expect(await p.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(dark);
      expect(await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(ground);
      expect(await p.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(dark);
    } finally {
      await p.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  // 077 (Amendment 14): the tray's Appearance › Light applies at once (no reload) and is saved to config.json.
  it("tray Appearance › Light restyles the open window live and saves theme light, other keys kept (077)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ timeoutSec: 99 }));
    const p = await launchPanel(dataDir);
    try {
      expect(await p.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
      await p.page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 77));
      await p.app.evaluate((_electron) => (globalThis as unknown as { snapsolveTest: { setTheme(t: string): Promise<void> } }).snapsolveTest.setTheme("light"));
      await expect.poll(() => p.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), { timeout: 5_000 }).toBe(false);
      await expect.poll(() => p.page.evaluate(() => getComputedStyle(document.body).backgroundColor), { timeout: 5_000 }).toBe("rgba(246, 246, 248, 0.88)");
      // Same document: restyled without a reload.
      expect(await p.page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(77);
      await expect
        .poll(() => JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")), { timeout: 5_000 })
        .toEqual({ timeoutSec: 99, theme: "light" });
    } finally {
      await p.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  // 076: code blocks on near-black with github-dark colors in the dark theme (light keeps github); answers in the New
  // York serif at 14 px, code in Menlo, the chrome in the system sans.
  it.each([
    { theme: "dark", dark: true },
    { theme: "light", dark: false },
  ])("theme $theme: a python block's background and keyword colors, and the answer/code/title bar fonts (076)", async ({ theme, dark }) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ theme }));
    const p = await launchPanel(dataDir, { FAKE_ANSWER_SUFFIX: "\n\n```python\ndef f(x):\n    return x + 1\n```\n" });
    try {
      const id = await capture(p.app);
      const code = p.page.locator(`${card(id)} .answer:not(.streaming) pre code.hljs`).first();
      await code.waitFor({ state: "visible", timeout: 20_000 });
      const look = await p.page.evaluate((sel) => {
        const codeEl = document.querySelector(sel) as HTMLElement;
        const answer = codeEl.closest(".answer") as HTMLElement;
        const keyword = codeEl.querySelector(".hljs-keyword") as HTMLElement;
        const style = (el: Element) => getComputedStyle(el);
        return {
          background: style(codeEl).backgroundColor,
          keyword: style(keyword).color,
          answerFont: style(answer).fontFamily,
          answerSize: style(answer).fontSize,
          codeFont: style(codeEl).fontFamily,
          titleFont: style(document.querySelector("#titlebar") as Element).fontFamily,
        };
      }, `${card(id)} .answer:not(.streaming) pre code.hljs`);
      const lum = luminance(look.background);
      if (dark) {
        expect(lum, look.background).toBeLessThan(0.1);
        expect(look.background).toBe("rgb(32, 35, 39)"); // grey #202327, not github-dark's near-black #0d1117
        expect(look.keyword).not.toBe("rgb(215, 58, 73)"); // github light's #d73a49
      } else {
        expect(lum, look.background).toBeGreaterThan(0.9);
      }
      expect(look.answerFont.startsWith("ui-serif"), look.answerFont).toBe(true);
      expect(look.answerSize).toBe("14px");
      expect(look.codeFont.startsWith("ui-monospace"), look.codeFont).toBe(true);
      expect(look.codeFont).toContain("Menlo");
      expect(look.titleFont.startsWith("-apple-system"), look.titleFont).toBe(true);
    } finally {
      await p.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  // 078 (Amendment 15, replaces 061's "Earlier" rows): one chat on screen; the others are in the Chats sidebar,
  // an overlay at the default 360 px. Choosing one shows it, and the composer and the next capture continue it.
  it("narrow: one chat on screen, Show chats opens the overlay newest first under Today, choosing the older one shows it and follow-ups and captures land in it (078)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    try {
      const older = await capture(p.app);
      await p.page.locator(`${card(older)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });
      await newChat(p.page);
      const newest = await capture(p.app);
      await p.page.locator(`${card(newest)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });

      // Only the newest chat's turns are on screen; the sidebar starts closed.
      expect(await p.page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId))).toEqual([newest]);
      expect(await nav.isVisible()).toBe(false);
      expect(await p.page.locator("#scrim").isVisible()).toBe(false);

      await showChats(p.page);
      expect(await p.page.locator("#scrim").isVisible()).toBe(true);
      expect(await chats(p.page)).toEqual([newest, older]);
      expect(await nav.locator(".chat-group").allInnerTexts()).toEqual(["Today"]);
      expect(await p.page.locator(`[data-chat-id="${newest}"]`).getAttribute("aria-current")).toBe("true");
      expect(await p.page.locator(`[data-chat-id="${older}"]`).getAttribute("aria-current")).toBeNull();
      expect((await p.page.locator(`[data-chat-id="${older}"]`).innerText()).trim().length).toBeGreaterThan(0);
      // An overlay: the sidebar sits over the chat, which keeps its full width.
      const navBox = await nav.boundingBox();
      const contentBox = await p.page.locator("#content").boundingBox();
      expect(navBox && contentBox && navBox.x < contentBox.x + 10 && contentBox.width > 300).toBe(true);

      // A click on the scrim (right of the sidebar) closes it.
      await p.page.mouse.click(340, 300);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);

      await chooseChat(p.page, older);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      await expect
        .poll(() => p.page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId)), { timeout: 5_000 })
        .toEqual([older]);

      const box = p.page.locator("#composer textarea");
      await box.fill("And the other root?");
      await box.press("Enter");
      await expect.poll(() => p.page.locator(`${card(older)} .answer:not(.streaming)`).count(), { timeout: 20_000 }).toBe(2);
      expect(await p.page.locator(`${card(older)} .question`).allInnerTexts()).toContain("And the other root?");

      expect(await capture(p.app)).toBe(older);
      await expect.poll(() => p.page.locator(`${card(older)} .answer:not(.streaming)`).count(), { timeout: 20_000 }).toBe(3);
      const saved = JSON.parse(readFileSync(path.join(p.dataDir, "threads", older, "thread.json"), "utf8")) as Thread;
      expect(saved.turns.filter((t) => t.role === "user" && t.kind === "screenshot")).toHaveLength(2);
      const other = JSON.parse(readFileSync(path.join(p.dataDir, "threads", newest, "thread.json"), "utf8")) as Thread;
      expect(other.turns.filter((t) => t.role === "user")).toHaveLength(1);
    } finally {
      await p.close();
    }
  }, 150_000);

  it("sidebar New chat empties the main area; the next typed question starts a thread that is current and listed first (078)", async () => {
    const p = await launchPanel();
    try {
      const first = await capture(p.app);
      await p.page.locator(`${card(first)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });
      await showChats(p.page);
      await p.page.locator('nav[aria-label="Chats"]').getByRole("button", { name: "New chat" }).click();
      await expect.poll(() => p.page.locator('nav[aria-label="Chats"]').isVisible(), { timeout: 5_000 }).toBe(false);
      expect(await p.page.locator("[data-thread-id]").count()).toBe(0);
      expect(await p.page.locator("#empty").isVisible()).toBe(true);

      const box = p.page.locator("#composer textarea");
      await box.fill("What is 2 + 2?");
      await box.press("Enter");
      await expect.poll(() => chats(p.page).then((c) => c.length), { timeout: 10_000 }).toBe(2);
      const [text] = await chats(p.page);
      expect(text).not.toBe(first);
      await expect.poll(() => p.page.locator(`${card(text!)} .answer:not(.streaming)`).count(), { timeout: 20_000 }).toBe(1);
      expect(await p.page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId))).toEqual([text]);
      expect(await p.page.locator(`[data-chat-id="${text}"]`).getAttribute("aria-current")).toBe("true");
    } finally {
      await p.close();
    }
  }, 120_000);

  it("wide: at 760 px the sidebar is docked open beside the chat (no scrim), the toggle collapses it, and back at 360 px it is a closed overlay (078)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });
      await setWindowWidth(p.app, 760);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(true);
      expect(await p.page.locator("#scrim").isVisible()).toBe(false);
      const navBox = await nav.boundingBox();
      const contentBox = await p.page.locator("#content").boundingBox();
      // Docked: the chat starts where the sidebar ends.
      expect(navBox && contentBox && contentBox.x >= navBox.x + navBox.width - 1).toBe(true);
      expect(await p.page.locator(`${card(id)} .answer`).first().isVisible()).toBe(true);
      // The chat column's title is the current chat's.
      expect((await p.page.locator("#titlebar .chat-title").innerText()).trim().length).toBeGreaterThan(0);

      await nav.getByRole("button", { name: "Hide chats" }).click();
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      await showChats(p.page);
      expect(await p.page.locator("#scrim").isVisible()).toBe(false);

      await setWindowWidth(p.app, 360);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      await showChats(p.page);
      expect(await p.page.locator("#scrim").isVisible()).toBe(true);
    } finally {
      await p.close();
    }
  }, 90_000);

  // 082 (Amendment 16): a sidebar the user closed stays closed through resizes until Show chats.
  it("wide, user closes: stays closed at 700, 360 and back at 760 px; Show chats then docks it open (082)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    try {
      await resizeTo(p, 760);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(true);
      await nav.getByRole("button", { name: "Hide chats" }).click();
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);

      for (const width of [700, 360, 760]) {
        await resizeTo(p, width);
        expect(await nav.isVisible(), `at ${width} px`).toBe(false);
        expect(await p.page.locator("#scrim").isVisible(), `at ${width} px`).toBe(false);
        expect(await p.page.locator("#titlebar").getByRole("button", { name: "Show chats" }).isVisible(), `at ${width} px`).toBe(true);
      }

      await showChats(p.page);
      expect(await p.page.locator("#scrim").isVisible()).toBe(false);
      const navBox = await nav.boundingBox();
      const contentBox = await p.page.locator("#content").boundingBox();
      expect(navBox && contentBox && contentBox.x >= navBox.x + navBox.width - 1).toBe(true);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("narrow, user opens then closes (the scrim, or choosing a chat): widening to 760 px keeps it closed (082)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });

      await showChats(p.page);
      await p.page.mouse.click(340, 300);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      await resizeTo(p, 760);
      expect(await nav.isVisible()).toBe(false);

      // Docked open, then narrowed: the overlay closes, but the user did not close it.
      await showChats(p.page);
      await resizeTo(p, 360);
      expect(await nav.isVisible()).toBe(false);
      // Choosing a chat in the narrow overlay closes it: a user close.
      await chooseChat(p.page, id);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      await resizeTo(p, 760);
      expect(await nav.isVisible()).toBe(false);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("never closed by the user: wide docks open, narrow closes the overlay, wide docks it open again; opened while narrow, widening docks it (082)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    const scrim = p.page.locator("#scrim");
    try {
      await resizeTo(p, 760);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(true);
      await resizeTo(p, 360);
      expect(await nav.isVisible()).toBe(false);
      expect(await scrim.isVisible()).toBe(false);
      await resizeTo(p, 760);
      expect(await nav.isVisible()).toBe(true);
      expect(await scrim.isVisible()).toBe(false);

      await resizeTo(p, 360);
      await showChats(p.page);
      expect(await scrim.isVisible()).toBe(true);
      await resizeTo(p, 760);
      expect(await nav.isVisible()).toBe(true);
      expect(await scrim.isVisible()).toBe(false);
    } finally {
      await p.close();
    }
  }, 90_000);

  // 085 (Amendment 19): the footer is the model, then the newest answer's response time.
  it("footer: the model alone before any answer, then model · the newest answer's time after a follow-up (085)", async () => {
    const p = await launchPanel(undefined, { FAKE_DELAY_MS: "1500", FAKE_DURATION_STEP_MS: "2000" });
    try {
      const id = await capture(p.app);
      const status = p.page.locator(`${card(id)} .status`);
      const threadFile = path.join(p.dataDir, "threads", id, "thread.json");
      const read = () => JSON.parse(readFileSync(threadFile, "utf8")) as Thread;
      await p.page.locator(`${card(id)} .thinking`).waitFor({ state: "visible", timeout: 5_000 });
      const model = read().model;
      expect(model.length).toBeGreaterThan(0);
      expect(await status.textContent()).toBe(model);

      await p.page.locator(`${card(id)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });
      await expect.poll(() => status.textContent(), { timeout: 5_000 }).toBe(`${model} · 1.2 s`);

      const box = p.page.locator("#composer textarea");
      await box.fill("And the other root?");
      await box.press("Enter");
      await expect.poll(() => p.page.locator(`${card(id)} .answer:not(.streaming)`).count(), { timeout: 20_000 }).toBe(2);
      // The second answer took 1234 + 2000 ms (the fake's step), so the footer is its time, not the first's.
      await expect.poll(() => status.textContent(), { timeout: 5_000 }).toBe(`${model} · 3.2 s`);
      const durations = read().turns.flatMap((t) => (t.role === "assistant" ? [t.durationMs] : []));
      expect(durations).toEqual([1234, 3234]);
    } finally {
      await p.close();
    }
  }, 90_000);

  // 084 (Amendment 18): no max width on the chat column, the empty state or the composer at any window size.
  it("1100 px: the empty state, chat column, answer and composer fill the area right of the docked sidebar, and the whole window once it is closed (084)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    const box = async (selector: string) => {
      const b = await p.page.locator(selector).first().boundingBox();
      if (!b) throw new Error(`${selector} has no box`);
      return { left: b.x, right: b.x + b.width, width: b.width };
    };
    // Spans [from, to] less `pad` on each side (2 px slack for hairlines and rounding).
    const spans = async (selector: string, from: number, to: number, pad: number) => {
      const b = await box(selector);
      return b.left <= from + pad + 2 && b.right >= to - pad - 2;
    };
    try {
      await resizeTo(p, 1100);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(true);
      const docked = (await box('nav[aria-label="Chats"]')).right;
      expect(await spans("#empty", docked, 1100, 16), "empty state, docked").toBe(true);

      const id = await capture(p.app);
      const answer = `${card(id)} .answer:not(.streaming)`;
      await p.page.locator(answer).first().waitFor({ state: "visible", timeout: 20_000 });
      // A capture shows the window at its saved size (059), so widen it again.
      await resizeTo(p, 1100);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(true);
      expect(await spans("#threads", docked, 1100, 0), "chat column, docked").toBe(true);
      expect(await spans(answer, docked, 1100, 10), "answer, docked").toBe(true);
      expect(await spans("#composer-box", docked, 1100, 10), "composer, docked").toBe(true);

      await nav.getByRole("button", { name: "Hide chats" }).click();
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      await expect.poll(() => spans(answer, 0, 1100, 10), { timeout: 5_000 }).toBe(true);
      expect(await spans("#threads", 0, 1100, 0), "chat column, closed").toBe(true);
      expect(await spans("#composer-box", 0, 1100, 10), "composer, closed").toBe(true);
      for (const selector of ["#threads", answer, "#composer-box"]) expect((await box(selector)).width, selector).toBeGreaterThan(1000);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("the answer tracks the window: 360 px fills it, and widening 760 → 1100 px with the sidebar closed widens it by about 340 px (084)", async () => {
    const p = await launchPanel();
    const nav = p.page.locator('nav[aria-label="Chats"]');
    try {
      const id = await capture(p.app);
      const answer = p.page.locator(`${card(id)} .answer:not(.streaming)`).first();
      await answer.waitFor({ state: "visible", timeout: 20_000 });
      const width = async () => (await answer.boundingBox())!.width;
      expect(await width()).toBeGreaterThanOrEqual(360 - 2 * 10 - 2);

      await resizeTo(p, 760);
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(true);
      await nav.getByRole("button", { name: "Hide chats" }).click();
      await expect.poll(() => nav.isVisible(), { timeout: 5_000 }).toBe(false);
      const at760 = await width();
      expect(at760).toBeGreaterThanOrEqual(760 - 2 * 10 - 2);
      await resizeTo(p, 1100);
      const grown = (await width()) - at760;
      expect(grown).toBeGreaterThan(330);
      expect(grown).toBeLessThan(350);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("a turn finishing in a chat that is not on screen leaves the main area alone (078)", async () => {
    const p = await launchPanel(undefined, { FAKE_DELAY_MS: "4000" });
    try {
      const first = await capture(p.app);
      await p.page.locator(`${card(first)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 30_000 });
      await newChat(p.page);
      const busy = await capture(p.app);
      await p.page.locator(`${card(busy)} .thinking`).waitFor({ state: "visible", timeout: 5_000 });
      await chooseChat(p.page, first);
      await expect
        .poll(() => p.page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId)), { timeout: 5_000 })
        .toEqual([first]);
      // Wait for the other chat's answer to be saved, then check nothing moved.
      await expect
        .poll(() => (JSON.parse(readFileSync(path.join(p.dataDir, "threads", busy, "thread.json"), "utf8")) as Thread).status, { timeout: 30_000 })
        .toBe("done");
      await new Promise((r) => setTimeout(r, 500));
      expect(await p.page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId))).toEqual([first]);
      expect(await chats(p.page)).toEqual([busy, first]);
    } finally {
      await p.close();
    }
  }, 120_000);

  it("chats are grouped Today, Yesterday, Previous 7 days, Older, newest first (078)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    const ids = {
      today: "1a1a1a1a-0000-4000-8000-000000000001",
      yesterday: "1a1a1a1a-0000-4000-8000-000000000002",
      week: "1a1a1a1a-0000-4000-8000-000000000003",
      older: "1a1a1a1a-0000-4000-8000-000000000004",
    };
    writeThread(dataDir, ids.older, "Older chat", daysAgo(20));
    writeThread(dataDir, ids.week, "Week chat", daysAgo(3));
    writeThread(dataDir, ids.yesterday, "Yesterday chat", daysAgo(1));
    writeThread(dataDir, ids.today, "Today chat", new Date(Date.now() - 60_000));
    const p = await launchPanel(dataDir);
    try {
      await p.page.locator(`[data-chat-id="${ids.today}"]`).waitFor({ state: "attached", timeout: 10_000 });
      await showChats(p.page);
      const order = await p.page
        .locator('nav[aria-label="Chats"] .chat-group, nav[aria-label="Chats"] [data-chat-id]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.chatId ?? `# ${e.textContent?.trim()}`));
      expect(order).toEqual(["# Today", ids.today, "# Yesterday", ids.yesterday, "# Previous 7 days", ids.week, "# Older", ids.older]);
      expect(await p.page.locator(`[data-chat-id="${ids.week}"]`).innerText()).toContain("Week chat");
      // The newest is on screen at startup.
      expect(await p.page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId))).toEqual([ids.today]);
    } finally {
      await p.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  it.each([
    { theme: "dark" },
    { theme: "light" },
  ])("theme $theme: the sidebar's background differs from the chat's (078)", async ({ theme }) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ theme }));
    writeThread(dataDir, "1a1a1a1a-0000-4000-8000-000000000009", "A chat", new Date());
    const p = await launchPanel(dataDir);
    try {
      await p.page.locator("[data-chat-id]").first().waitFor({ state: "attached", timeout: 10_000 });
      await showChats(p.page);
      const [sidebar, ground] = await p.page.evaluate(() => [
        getComputedStyle(document.querySelector('nav[aria-label="Chats"]') as Element).backgroundColor,
        getComputedStyle(document.body).backgroundColor,
      ]);
      expect(sidebar).not.toBe(ground);
      expect(sidebar).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      await p.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  it("+ button starts a fresh card: captures continue the chat, + then a capture or a typed question starts a new one (065)", async () => {
    const p = await launchPanel();
    // 078: the chats are listed in the sidebar; only the current one is on screen.
    const ids = () => chats(p.page);
    const answers = (id: string) => p.page.locator(`${card(id)} .answer:not(.streaming)`).count();
    try {
      const first = await capture(p.app);
      await expect.poll(() => answers(first), { timeout: 20_000 }).toBe(1);
      expect(await capture(p.app)).toBe(first);
      await expect.poll(() => answers(first), { timeout: 20_000 }).toBe(2);
      expect(await ids()).toEqual([first]);
      // The appended screenshot shows in the chat where it joined (078: after the first one, also in the turns).
      expect(await p.page.locator(`${card(first)} .turns img.thumb`).evaluateAll((els) => els.map((e) => e.getAttribute("src")))).toEqual([
        `snapsolve://thread/${first}/1.png`,
        `snapsolve://thread/${first}/2.png`,
      ]);

      const plus = p.page.locator("#titlebar").getByRole("button", { name: "New chat" });
      expect(await plus.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"))).toBe("no-drag");
      // Before the ×, at the top right.
      // 063 put the mic (Dictate) first; 078 put the sidebar toggle before everything.
      expect(await p.page.locator("#titlebar button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual([
        "Show chats",
        "Dictate",
        "New chat",
        "Hide window",
      ]);
      await plus.click();
      // 078: the chat leaves the screen (it stays in the sidebar) and the empty state shows.
      await expect.poll(() => p.page.locator(`${card(first)} .answer`).first().isVisible(), { timeout: 5_000 }).toBe(false);
      expect(await p.page.locator("[data-thread-id]").count()).toBe(0);
      expect(await p.page.locator("#empty").isVisible()).toBe(true);
      expect(await ids()).toEqual([first]);

      // + then a typed question: a new text thread, no thumbnail.
      const box = p.page.locator("#composer textarea");
      await box.fill("What is 2 + 2?");
      await box.press("Enter");
      await expect.poll(async () => (await ids()).length, { timeout: 10_000 }).toBe(2);
      const text = (await ids())[0] as string;
      expect(text).not.toBe(first);
      await expect.poll(() => answers(text), { timeout: 20_000 }).toBe(1);
      expect(await p.page.locator(`${card(text)} .question`).allInnerTexts()).toEqual(["What is 2 + 2?"]);
      expect(await p.page.locator(`${card(text)} .answer`).first().innerText()).toContain("saw 0 image(s)");
      expect(await p.page.locator(`${card(text)} img.thumb`).count()).toBe(0);
      // The old thread got nothing (078: choose it in the sidebar to see it).
      await chooseChat(p.page, first);
      await expect.poll(() => answers(first), { timeout: 5_000 }).toBe(2);
      expect(await p.page.locator(`${card(first)} .question`).count()).toBe(0);

      // + then a capture: a new screenshot card; the one after continues it.
      await newChat(p.page);
      const third = await capture(p.app);
      expect([first, text]).not.toContain(third);
      await expect.poll(() => answers(third), { timeout: 20_000 }).toBe(1);
      expect(await ids()).toEqual([third, text, first]);
      expect(await capture(p.app)).toBe(third);
    } finally {
      await p.close();
    }
  }, 150_000);

  it("Retry shows only on an errored turn (061)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
    const scenarioFile = path.join(projects, "scenario");
    writeFileSync(scenarioFile, "error");
    const launched = await launchApp({
      dataDir,
      env: { SNAPSOLVE_TEST_CLAUDE: FAKE, SNAPSOLVE_TEST_PROJECTS: projects, FAKE_PROJECTS: projects, FAKE_CLAUDE_SCENARIO_FILE: scenarioFile },
    });
    try {
      const page = await launched.app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const id = await capture(launched.app);
      const retry = page.locator(`${card(id)} .retry`);
      await retry.waitFor({ state: "visible", timeout: 20_000 });
      expect(await page.locator(`${card(id)} .error`).first().isVisible()).toBe(true);

      writeFileSync(scenarioFile, "ok");
      await retry.click();
      await page.locator(`${card(id)} .answer:not(.streaming)`).first().waitFor({ state: "visible", timeout: 20_000 });
      await expect.poll(() => retry.isVisible(), { timeout: 5_000 }).toBe(false);
    } finally {
      await launched.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      rmSync(projects, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);

  it("a capture past maxScreenshotsPerThread opens a new card that says it continues the previous thread, its claude given the last answer (051)", async () => {
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

      // A capture continues the current thread (065); past maxScreenshotsPerThread it starts a seeded one.
      const next = await capture(launched.app);
      expect(next).not.toBe(first);
      const note = page.locator(`${card(next)} .note`);
      await note.waitFor({ state: "visible", timeout: 10_000 });
      expect(await note.textContent()).toBe(CONTINUED_NOTE);
      await page.locator(`${card(next)} .answer`).first().waitFor({ state: "visible", timeout: 20_000 });
      // 078: the new thread is on screen; both are in the sidebar.
      expect(await page.locator("[data-thread-id]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId))).toEqual([next]);
      expect(await chats(page)).toEqual([next, first]);

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
      // A capture continues the current thread (065); past maxScreenshotsPerThread it starts a seeded one.
      const next = await capture(launched.app);
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

  // 079 (Amendment 15): the composer is a ChatGPT-style pill — mic at the left, the text, a round send at the right.
  it.each([{ theme: "dark" }, { theme: "light" }])("theme $theme: the composer is a pill with the mic left of the text and a round send right of it (079)", async ({ theme }) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ theme }));
    const p = await launchPanel(dataDir);
    try {
      const corners = await p.page.locator("#composer-box").evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((v) => Number.parseFloat(v));
      });
      for (const r of corners) expect(r).toBeGreaterThanOrEqual(18);

      const boxRect = (await p.page.locator("#composer-box").boundingBox())!;
      const mic = (await p.page.locator("#composer-voice").boundingBox())!;
      const text = (await p.page.locator("#follow-up").boundingBox())!;
      const send = (await p.page.locator("#send").boundingBox())!;
      expect(mic.x + mic.width).toBeLessThanOrEqual(text.x + 0.5);
      expect(send.x).toBeGreaterThanOrEqual(text.x + text.width - 0.5);
      for (const r of [mic, text, send]) {
        expect(r.x).toBeGreaterThanOrEqual(boxRect.x);
        expect(r.x + r.width).toBeLessThanOrEqual(boxRect.x + boxRect.width + 0.5);
        expect(r.y).toBeGreaterThanOrEqual(boxRect.y);
        expect(r.y + r.height).toBeLessThanOrEqual(boxRect.y + boxRect.height + 0.5);
      }

      // Round send, faded until there is something to send.
      const sendLook = () =>
        p.page.locator("#send").evaluate((el) => {
          const s = getComputedStyle(el);
          return { radius: Number.parseFloat(s.borderTopLeftRadius), width: el.getBoundingClientRect().width, opacity: Number(s.opacity) };
        });
      const empty = await sendLook();
      expect(empty.radius).toBeGreaterThanOrEqual(empty.width / 2);
      expect(empty.opacity).toBeLessThan(1);
      await p.page.locator("#follow-up").fill("x");
      expect((await sendLook()).opacity).toBe(1);
    } finally {
      await p.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  it("the composer says Ask anything with no chat on screen and Ask a follow-up with one (079)", async () => {
    const p = await launchPanel();
    const placeholder = () => p.page.locator("#follow-up").getAttribute("placeholder");
    try {
      expect(await placeholder()).toBe("Ask anything");
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .thinking, ${card(id)} .answer`).first().waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(placeholder, { timeout: 5_000 }).toBe("Ask a follow-up");
      await newChat(p.page);
      await expect.poll(placeholder, { timeout: 5_000 }).toBe("Ask anything");
    } finally {
      await p.close();
    }
  }, 60_000);

  it("five lines grow the pill; the mic and send stay at its bottom, level with each other (079)", async () => {
    const p = await launchPanel();
    try {
      const box = p.page.locator("#composer-box");
      const before = (await box.boundingBox())!.height;
      await p.page.locator("#follow-up").fill("one\ntwo\nthree\nfour\nfive");
      await expect.poll(async () => (await box.boundingBox())!.height, { timeout: 5_000 }).toBeGreaterThan(before + 40);
      const b = (await box.boundingBox())!;
      const mic = (await p.page.locator("#composer-voice").boundingBox())!;
      const send = (await p.page.locator("#send").boundingBox())!;
      const micGap = b.y + b.height - (mic.y + mic.height);
      const sendGap = b.y + b.height - (send.y + send.height);
      expect(Math.abs(micGap - sendGap)).toBeLessThanOrEqual(1);
      expect(sendGap).toBeGreaterThanOrEqual(0);
      expect(sendGap).toBeLessThanOrEqual(8);
      // Still rounded when tall.
      expect(Number.parseFloat(await box.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(18);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("the listening bar takes the composer's pill shape (079)", async () => {
    const p = await launchPanel();
    try {
      const pill = await p.page.locator("#composer-box").evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      await voiceKey(p.app);
      const bar = p.page.locator("#listening");
      await bar.waitFor({ state: "visible", timeout: 5_000 });
      expect(await bar.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(pill);
      await voiceEscape(p.app);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("wide: the pill is centred under the chat column (079)", async () => {
    const p = await launchPanel();
    try {
      await setWindowWidth(p.app, 760);
      await p.page.locator('nav[aria-label="Chats"]').waitFor({ state: "visible", timeout: 5_000 });
      const column = (await p.page.locator("#content").boundingBox())!;
      const b = (await p.page.locator("#composer-box").boundingBox())!;
      const left = b.x - column.x;
      const right = column.x + column.width - (b.x + b.width);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("voice: hotkey → listening bar with the live transcript → hotkey again → the question in the newest card with a mic mark, answered (063)", async () => {
    const p = await launchPanel();
    const answers = (id: string) => p.page.locator(`${card(id)} .answer:not(.streaming)`).count();
    try {
      const id = await capture(p.app);
      await expect.poll(() => answers(id), { timeout: 20_000 }).toBe(1);
      await p.page.locator("#hide").click();
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(false);

      await voiceKey(p.app);
      // Shown (it was hidden), without taking focus; the composer is the listening bar.
      await expect.poll(async () => (await windowInfo(p.app)).visible, { timeout: 5_000 }).toBe(true);
      expect((await windowInfo(p.app)).focused).toBe(false);
      const bar = p.page.locator("#listening");
      await bar.waitFor({ state: "visible", timeout: 5_000 });
      expect(await p.page.locator("#follow-up").isVisible()).toBe(false);
      expect(await bar.locator(".dot").isVisible()).toBe(true);
      expect(await bar.locator(".levels .level").count()).toBeGreaterThan(0);
      expect(await bar.locator(".hint").innerText()).toBe("⌃⌥V to send · esc to cancel");
      await expect.poll(() => bar.locator(".transcript").innerText(), { timeout: 5_000 }).toContain("why the product");
      expect(await escapeRegistered(p.app)).toBe(true);

      await voiceKey(p.app);
      const asked = p.page.locator(`${card(id)} .question.voice`);
      await asked.waitFor({ state: "visible", timeout: 10_000 });
      expect(await asked.innerText()).toContain("why the product rule?");
      expect(await asked.locator(".mic-mark").count()).toBe(1);
      await expect.poll(() => answers(id), { timeout: 20_000 }).toBe(2);
      // Back to the composer; the temporary Esc is gone.
      await expect.poll(() => bar.isVisible(), { timeout: 5_000 }).toBe(false);
      expect(await p.page.locator("#follow-up").isVisible()).toBe(true);
      expect(await escapeRegistered(p.app)).toBe(false);
      // Saved as a dictated text turn.
      const saved = JSON.parse(readFileSync(path.join(p.dataDir, "threads", id, "thread.json"), "utf8"));
      expect(saved.turns.filter((t: { kind?: string }) => t.kind === "text")).toEqual([
        { role: "user", kind: "text", text: "why the product rule?", voice: true },
      ]);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("voice: Esc cancels (nothing sent, Esc released); the composer's mic button does what the hotkey does (063)", async () => {
    const p = await launchPanel();
    const answers = (id: string) => p.page.locator(`${card(id)} .answer:not(.streaming)`).count();
    try {
      const id = await capture(p.app);
      await expect.poll(() => answers(id), { timeout: 20_000 }).toBe(1);
      const bar = p.page.locator("#listening");

      await voiceKey(p.app);
      await expect.poll(() => bar.locator(".transcript").innerText(), { timeout: 5_000 }).toContain("why");
      await voiceEscape(p.app);
      await expect.poll(() => bar.isVisible(), { timeout: 5_000 }).toBe(false);
      expect(await escapeRegistered(p.app)).toBe(false);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await p.page.locator(`${card(id)} .question`).count()).toBe(0);

      const mic = p.page.locator("#composer-voice");
      expect(await mic.getAttribute("aria-label")).toBe("Dictate");
      await mic.click();
      await expect.poll(() => bar.locator(".transcript").innerText(), { timeout: 5_000 }).toContain("why the product");
      await p.page.locator("#voice").click();
      await p.page.locator(`${card(id)} .question.voice`).waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => answers(id), { timeout: 20_000 }).toBe(2);
    } finally {
      await p.close();
    }
  }, 90_000);

  it("voice: an empty transcript sends nothing and says Didn't catch that (063)", async () => {
    const p = await launchPanel(undefined, { FAKE_SPEECH_SCENARIO: "empty" });
    try {
      await voiceKey(p.app);
      await p.page.locator("#listening").waitFor({ state: "visible", timeout: 5_000 });
      await voiceKey(p.app);
      const note = p.page.locator("#voice-note");
      await expect.poll(() => note.innerText(), { timeout: 5_000 }).toBe("Didn't catch that.");
      expect(await p.page.locator("[data-thread-id]").count()).toBe(0);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("voice: mic denied shows a permission card with Open System Settings and no Retry (063)", async () => {
    const p = await launchPanel(undefined, { FAKE_SPEECH_SCENARIO: "denied" });
    try {
      await voiceKey(p.app);
      const permission = p.page.locator(".card.permission");
      await permission.waitFor({ state: "visible", timeout: 5_000 });
      expect(await permission.locator(".error").textContent()).toMatch(/Microphone/);
      expect(await permission.locator("button.open-settings").isVisible()).toBe(true);
      expect(await permission.locator("button.relaunch").count()).toBe(0);
      expect(await permission.locator(".retry").isVisible()).toBe(false);
      expect(await p.page.locator("#listening").isVisible()).toBe(false);
      expect(await escapeRegistered(p.app)).toBe(false);
    } finally {
      await p.close();
    }
  }, 60_000);

  it("voice: a helper that crashes shows an error card, no buttons, and the composer is back (063)", async () => {
    const p = await launchPanel(undefined, { FAKE_SPEECH_SCENARIO: "crash" });
    try {
      await voiceKey(p.app);
      const card = p.page.locator(".card.permission");
      await card.waitFor({ state: "visible", timeout: 10_000 });
      expect(await card.locator(".error").textContent()).toBe("Voice input stopped working. Details are in the snapsolve log.");
      expect(await card.locator("button").count()).toBe(0);
      await expect.poll(() => p.page.locator("#listening").isVisible(), { timeout: 5_000 }).toBe(false);
      expect(await p.page.locator("#follow-up").isVisible()).toBe(true);
      expect(await escapeRegistered(p.app)).toBe(false);
    } finally {
      await p.close();
    }
  }, 60_000);
});
