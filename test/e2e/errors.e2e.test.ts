import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { AssistantTurn, Thread } from "../../src/shared/types";
import { fixturesDir } from "../paths";
import { launchApp, type LaunchedApp } from "./helpers";

const FAKE = path.join(fixturesDir, "fake-claude.mjs");
const PROBLEM = path.join(fixturesDir, "problems", "algebra.png");

interface Launched extends LaunchedApp {
  page: Page;
  /** Switches the fake claude's scenario for every later spawn. */
  scenario(name: string): void;
}

interface TestHooks {
  captureFromFile(p: string): Promise<string>;
  notifications(): string[];
}

/**
 * The built app in test mode with its own data dir and `config.json`. With `fake: false` the app resolves claude
 * from the config (no SNAPSOLVE_TEST_CLAUDE); otherwise claude is the fake, its scenario read from a file.
 */
async function launch(options: { config?: Record<string, unknown>; fake?: boolean; scenario?: string; env?: Record<string, string> } = {}): Promise<Launched> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-errors-"));
  const projects = mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-projects-"));
  const scenarioFile = path.join(projects, "scenario");
  writeFileSync(scenarioFile, options.scenario ?? "ok");
  if (options.config) writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(options.config));
  const env: Record<string, string> = { FAKE_PROJECTS: projects, FAKE_CLAUDE_SCENARIO_FILE: scenarioFile };
  if (options.fake !== false) Object.assign(env, { SNAPSOLVE_TEST_CLAUDE: FAKE, SNAPSOLVE_TEST_PROJECTS: projects });
  Object.assign(env, options.env);
  const launched = await launchApp({ dataDir, env });
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return {
    ...launched,
    page,
    scenario: (name) => writeFileSync(scenarioFile, name),
    close: async () => {
      await launched.close();
      for (const dir of [dataDir, projects]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

function capture(app: ElectronApplication): Promise<string> {
  return app.evaluate(
    (_electron, png) => (globalThis as unknown as { snapsolveTest: TestHooks }).snapsolveTest.captureFromFile(png),
    PROBLEM,
  );
}

function notifications(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { snapsolveTest: TestHooks }).snapsolveTest.notifications());
}

const card = (id: string) => `[data-thread-id="${id}"]`;

describe("error states (e2e)", () => {
  it("a missing claudePath shows exactly the not-found text on the card, and startup says so too", async () => {
    const missing = path.join(tmpdir(), "snapsolve-no-such-dir", process.platform === "win32" ? "claude.exe" : "claude");
    const p = await launch({ fake: false, config: { claudePath: missing } });
    try {
      const id = await capture(p.app);
      const error = p.page.locator(`${card(id)} .error`);
      await error.waitFor({ state: "visible", timeout: 15_000 });
      expect(await error.textContent()).toBe("Claude Code not found. Run /snapsolve install.");
      expect(await p.page.locator(`${card(id)} .retry`).isVisible()).toBe(true);
      await expect
        .poll(() => notifications(p.app), { timeout: 10_000 })
        .toContain("Claude Code not found. Run /snapsolve install.");
    } finally {
      await p.close();
    }
  });

  it("a hung claude is killed at the timeout with Retry; Retry after the fake recovers renders the answer", async () => {
    const p = await launch({ scenario: "hang", config: { timeoutSec: 10 } });
    try {
      const id = await capture(p.app);
      const retry = p.page.locator(`${card(id)} .retry`);
      await retry.waitFor({ state: "visible", timeout: 30_000 });
      expect(await p.page.locator(`${card(id)} .error`).last().textContent()).toBe("Timed out and stopped. Press Retry to try again.");

      p.scenario("ok");
      await retry.click();
      const answer = p.page.locator(`${card(id)} .answer`);
      await answer.first().waitFor({ state: "visible", timeout: 15_000 });
      expect(await answer.last().textContent()).toContain("saw 1 image(s).");
      await expect.poll(() => retry.isVisible(), { timeout: 5_000 }).toBe(false);
    } finally {
      await p.close();
    }
  });

  // 085 (Amendment 19): the footer is the model and the response time only; usage stays in the tray tooltip.
  // 086 (Amendment 20): the model is the one claude reported for the answer, by name.
  it("an answer's footer is the reported model's name and the response time only, no TTFT or usage; a logged-in claude raises no startup notice (085, 086)", async () => {
    const p = await launch({ env: { FAKE_INIT_MODEL: "claude-opus-5-5" } });
    try {
      const id = await capture(p.app);
      await p.page.locator(`${card(id)} .answer`).first().waitFor({ state: "visible", timeout: 15_000 });
      const threadFile = path.join(p.dataDir, "threads", id, "thread.json");
      await expect.poll(() => existsSync(threadFile) && (JSON.parse(readFileSync(threadFile, "utf8")) as Thread).status, { timeout: 10_000 }).toBe("done");
      const thread = JSON.parse(readFileSync(threadFile, "utf8")) as Thread;
      const turn = thread.turns.filter((t): t is AssistantTurn => t.role === "assistant").at(-1)!;
      // The fake reported usage and a TTFT for this turn; the footer leaves both out.
      expect(turn.usage).toBe("5h 12% · 7d 34%");
      expect(turn.ttftMs).toBe(321);
      expect(turn.model).toBe("claude-opus-5-5");
      const expected = `Opus 5.5 · ${(turn.durationMs / 1000).toFixed(1)} s`;
      await expect.poll(() => p.page.locator(`${card(id)} .footer`).textContent(), { timeout: 5_000 }).toBe(expected);
      const footer = (await p.page.locator(`${card(id)} .footer`).textContent())!;
      expect(footer).not.toContain("TTFT");
      expect(footer).not.toContain("%");
      expect(footer).not.toContain("5h");
      expect(await notifications(p.app)).toEqual([]);
    } finally {
      await p.close();
    }
  });

  it("an API-key session shows the billing warning on the card", async () => {
    const p = await launch({ scenario: "api-key" });
    try {
      const id = await capture(p.app);
      const warning = p.page.locator(`${card(id)} .warning`);
      await warning.waitFor({ state: "visible", timeout: 15_000 });
      expect(await warning.textContent()).toBe("Warning: billing to an API key.");
    } finally {
      await p.close();
    }
  });

  it("logged out at startup → the log-in notice", async () => {
    const p = await launch({ scenario: "not-logged-in" });
    try {
      await expect.poll(() => notifications(p.app), { timeout: 10_000 }).toContain("Run `claude` once and log in.");
    } finally {
      await p.close();
    }
  });
});
