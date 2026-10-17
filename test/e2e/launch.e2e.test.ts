import { describe, expect, it } from "vitest";
import { launchApp } from "./helpers";

describe("app launch (e2e)", () => {
  it("launches the built app, reports its name, receives SNAPSOLVE_DATA_DIR and exits cleanly", async () => {
    const started = Date.now();
    const { app, dataDir, close } = await launchApp();
    let closed = false;
    try {
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe("snapsolve");
      expect(await app.evaluate(() => process.env.SNAPSOLVE_DATA_DIR)).toBe(dataDir);
      expect(await app.evaluate(() => process.env.SNAPSOLVE_TEST)).toBe("1");
      const child = app.process();
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      await close();
      closed = true;
      const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
      expect(code).not.toBe("timeout");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (!closed) await close();
    }
  }, 60_000);

  it("fails with a build hint when the main script is missing", async () => {
    await expect(launchApp({ mainPath: "dist/does-not-exist.js" })).rejects.toThrow(/run npm run build/);
  });
});
