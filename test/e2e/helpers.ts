import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication } from "playwright-core";
import { repoRoot } from "../paths";

export interface LaunchOptions {
  /** Main script relative to the repo root (default `dist/main.js`). */
  mainPath?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Reuse an existing data dir instead of a fresh temp dir (it is then not deleted on close). */
  dataDir?: string;
}

export interface LaunchedApp {
  app: ElectronApplication;
  dataDir: string;
  close: () => Promise<void>;
}

/** Launch the built app in test mode with an isolated data dir. */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const main = path.resolve(repoRoot, opts.mainPath ?? "dist/main.js");
  if (!existsSync(main)) {
    throw new Error(`${path.relative(repoRoot, main)} not found — run npm run build first`);
  }
  const ownsDataDir = !opts.dataDir;
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(tmpdir(), "snapsolve-e2e-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { SNAPSOLVE_TEST: "1", SNAPSOLVE_DATA_DIR: dataDir }, opts.env);

  const executablePath = createRequire(path.join(repoRoot, "package.json"))("electron") as string;
  const app = await _electron.launch({
    executablePath,
    args: [main, ...(opts.args ?? [])],
    env,
    cwd: repoRoot,
    timeout: 30_000,
    // Playwright emulates a light prefers-color-scheme by default; the app's own theme (075) must show through.
    colorScheme: null,
  });

  const close = async () => {
    await app.close().catch(() => undefined);
    if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { app, dataDir, close };
}
