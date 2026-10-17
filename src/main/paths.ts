// The data dir per OS (SPEC §5.1) and its fixed layout. The platform is a parameter so both branches are testable.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SnapsolveError } from "../shared/errors";

const APP_DIR = "snapsolve";

/**
 * `SNAPSOLVE_DATA_DIR` (absolute; any platform, for tests) → win32 `%LOCALAPPDATA%\snapsolve`
 * → darwin `~/Library/Application Support/snapsolve`. Throws `SnapsolveError` instead of guessing.
 */
export function resolveDataDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const p = platform === "win32" ? path.win32 : path.posix;

  const override = env.SNAPSOLVE_DATA_DIR;
  if (override) {
    if (!p.isAbsolute(override)) {
      throw new SnapsolveError("dataDirUnavailable", `SNAPSOLVE_DATA_DIR must be an absolute path, got "${override}"`);
    }
    return p.normalize(override);
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (!local || !p.isAbsolute(local)) {
      throw new SnapsolveError("dataDirUnavailable", `LOCALAPPDATA is not an absolute path: "${local ?? ""}"`);
    }
    return p.join(local, APP_DIR);
  }
  if (platform === "darwin") {
    if (!home || !p.isAbsolute(home)) {
      throw new SnapsolveError("dataDirUnavailable", `home directory is not an absolute path: "${home}"`);
    }
    return p.join(home, "Library", "Application Support", APP_DIR);
  }
  throw new SnapsolveError("unsupportedPlatform", `unsupported platform: ${platform}`);
}

export interface DataPaths {
  dir: string;
  config: string;
  threads: string;
  sessions: string;
  logs: string;
  logFile: string;
  /** Packaged app versions (M2 bootstrap); created by the installer, not by ensureDirs. */
  app: string;
  /** Where the floating window was left, per display (task 058); not config.json. */
  windowState: string;
}

export function dataPaths(dir: string): DataPaths {
  return {
    dir,
    config: path.join(dir, "config.json"),
    threads: path.join(dir, "threads"),
    sessions: path.join(dir, "sessions"),
    logs: path.join(dir, "logs"),
    logFile: path.join(dir, "logs", "snapsolve.log"),
    app: path.join(dir, "app"),
    windowState: path.join(dir, "window.json"),
  };
}

/** Creates the data dir, threads/, sessions/ and logs/ if missing. Safe to call repeatedly. */
export async function ensureDirs(paths: DataPaths): Promise<void> {
  for (const d of [paths.dir, paths.threads, paths.sessions, paths.logs]) {
    try {
      await mkdir(d, { recursive: true });
    } catch (cause) {
      throw new SnapsolveError("dataDirUnavailable", `cannot create ${d}`, { cause });
    }
  }
}
