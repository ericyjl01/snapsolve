import { defineConfig } from "vitest/config";

// `npm test`: unit + integration (parallel) and e2e (sequential, against a fresh build).
// Live tests that call the real `claude` are in vitest.live.config.ts and never run here.
export default defineConfig({
  test: {
    // Fails the whole run if any project leaves untracked, non-ignored files behind.
    globalSetup: ["test/git-clean-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          globalSetup: ["test/e2e/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
