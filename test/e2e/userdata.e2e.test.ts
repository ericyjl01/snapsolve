import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchApp, type LaunchedApp } from "./helpers";

async function paths(launched: LaunchedApp) {
  return launched.app.evaluate(({ app }) => ({ userData: app.getPath("userData"), appData: app.getPath("appData") }));
}

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

describe("Electron userData (e2e)", () => {
  it("with SNAPSOLVE_DATA_DIR: userData is <data>/electron, exists after launch and is not under appData", async () => {
    const launched = await launchApp();
    try {
      const { userData, appData } = await paths(launched);
      expect(userData).toBe(path.join(launched.dataDir, "electron"));
      expect(existsSync(userData)).toBe(true);
      expect(isInside(userData, appData)).toBe(false);
    } finally {
      await launched.close();
    }
  }, 60_000);

  it("without the override: userData is <platform data dir>/electron (win32 never under Roaming appData)", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "snapsolve-userdata-")));
    const env: Record<string, string> =
      process.platform === "win32" ? { SNAPSOLVE_DATA_DIR: "", LOCALAPPDATA: home } : { SNAPSOLVE_DATA_DIR: "", HOME: home };
    const dataDir =
      process.platform === "win32" ? path.join(home, "snapsolve") : path.join(home, "Library", "Application Support", "snapsolve");
    const launched = await launchApp({ env });
    try {
      const { userData, appData } = await paths(launched);
      expect(userData).toBe(path.join(dataDir, "electron"));
      expect(existsSync(userData)).toBe(true);
      // Roaming %APPDATA% can be synced by roaming profiles; macOS appData is the data dir's own parent.
      if (process.platform === "win32") expect(isInside(userData, appData)).toBe(false);
    } finally {
      await launched.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
