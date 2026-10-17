import { defineConfig } from "vitest/config";

// `npm run test:live`: tests that call the real `claude` CLI and consume plan usage.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
