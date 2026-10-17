import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root and shared test locations, independent of the cwd vitest was started from. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixturesDir = path.join(repoRoot, "test", "fixtures");
