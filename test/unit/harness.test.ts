import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDir, repoRoot } from "../paths";

describe("test harness", () => {
  it("runs TypeScript with Node built-ins", () => {
    const digest: string = createHash("sha256").update("snapsolve").digest("hex");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves the repo root and test/fixtures", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.name).toBe("snapsolve");
    expect(fixturesDir).toBe(path.join(repoRoot, "test", "fixtures"));
    expect(existsSync(path.join(fixturesDir, "README.md"))).toBe(true);
  });

  it("wires npm test and npm run test:live to the right configs", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:live"]).toBe("vitest run --config vitest.live.config.ts");
  });

  it("keeps live tests out of npm test and runs only them in test:live", async () => {
    const main = (await import("../../vitest.config")).default as {
      test: { projects: { test: { name: string; include: string[]; fileParallelism?: boolean } }[] };
    };
    const includes = main.test.projects.flatMap((p) => p.test.include);
    expect(includes).toEqual(
      expect.arrayContaining(["test/unit/**/*.test.ts", "test/integration/**/*.test.ts", "test/e2e/**/*.test.ts"]),
    );
    expect(includes.some((g) => g.includes("live"))).toBe(false);
    const e2e = main.test.projects.find((p) => p.test.name === "e2e");
    expect(e2e?.test.fileParallelism).toBe(false);

    const live = (await import("../../vitest.live.config")).default as {
      test: { include: string[]; passWithNoTests: boolean };
    };
    expect(live.test.include).toEqual(["test/live/**/*.test.ts"]);
    expect(live.test.passWithNoTests).toBe(true);
  });

  it("npm run test:live is wired and exits 0 — without running any live test", () => {
    // The filter matches no file, so no real-claude test ever runs inside npm test.
    const r = spawnSync("npm run test:live -- test/live/__no_match__", { cwd: repoRoot, shell: true, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/No test files found/);
  }, 60_000);

  it("the suite's git-clean teardown fails when a test leaves an untracked file", async () => {
    const setup = (await import("../git-clean-setup")).default;
    const teardown = setup();
    const stray = path.join(repoRoot, `stray-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(stray, "x");
    try {
      expect(() => teardown()).toThrow(/left files git does not ignore[\s\S]*stray-/);
    } finally {
      rmSync(stray, { force: true });
    }
    expect(() => teardown()).not.toThrow();
  });

  it("runs the git-clean check for the whole suite", async () => {
    const main = (await import("../../vitest.config")).default as { test: { globalSetup: string[] } };
    expect(main.test.globalSetup).toEqual(["test/git-clean-setup.ts"]);
  });

  it("sets keel's full-suite command and keeps keel caps within limits", () => {
    const keel = JSON.parse(readFileSync(path.join(repoRoot, ".claude", "memory", "keel.json"), "utf8"));
    expect(keel.test_command).toBe("npm test");
    const caps = spawnSync("python3", [".claude/memory/check.py", "caps"], { cwd: repoRoot, encoding: "utf8" });
    expect(caps.status, caps.stdout + caps.stderr).toBe(0);
  });

  it("git-ignores build, dependency and coverage artifacts", () => {
    for (const p of ["node_modules/x", "dist/main.js", "coverage/index.html", "npm-debug.log"]) {
      const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: repoRoot });
      expect(r.status, `${p} must be ignored`).toBe(0);
    }
  });
});
