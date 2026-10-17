// Claude Code's login and usage (SPEC §3.6): `claude auth status` (at startup and after an error result) and the
// rate-limit windows from `rate_limit_event` as the tray tooltip and card footer show them.
import type { Logger } from "./log";
import type { Command } from "./runner";
import type { RateWindow } from "./stream";

const AUTH_TIMEOUT_MS = 15_000;

/** `util.promisify(execFile)`: resolves on exit 0; rejects with `code` (exit code or errno string) and `stdout`. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * What `claude auth status` said. Only these fields leave this module: the output also holds the account's email
 * and organization, which are never returned or logged.
 */
export type AuthStatus =
  | { kind: "ok"; loggedIn: boolean; authMethod: string | null; subscriptionType: string | null }
  | { kind: "claudeNotFound" }
  | { kind: "unknown" };

/** The latest `rate_limit_event` (stream.ts `rateLimit`); `resetsAt` in unix seconds. */
export interface UsageInfo {
  status: string;
  resetsAt: number | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
}

/** Runs `<command> auth status`. Never throws: a failure to run or read it is `claudeNotFound` or `unknown`. */
export async function checkAuth(deps: {
  execFile: ExecFileFn;
  command: Command;
  env: Record<string, string | undefined>;
  log?: Logger;
}): Promise<AuthStatus> {
  const { log } = deps;
  let stdout: string;
  try {
    ({ stdout } = await deps.execFile(deps.command.path, [...deps.command.prefixArgs, "auth", "status"], {
      env: deps.env,
      timeout: AUTH_TIMEOUT_MS,
      windowsHide: true,
    }));
  } catch (e) {
    const failure = e as { code?: unknown; stdout?: unknown };
    if (failure.code === "ENOENT") {
      log?.warn("auth.claudeNotFound", {});
      return { kind: "claudeNotFound" };
    }
    // A logged-out claude exits 1 with the same JSON, so the output decides, not the exit code.
    stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    if (!stdout) {
      log?.warn("auth.unknown", { reason: "no output", code: typeof failure.code === "number" ? failure.code : String(failure.code) });
      return { kind: "unknown" };
    }
  }
  const parsed = parseObject(stdout);
  if (!parsed || !("loggedIn" in parsed)) {
    // The output is never logged: it may name the account.
    log?.warn("auth.unknown", { reason: "not auth JSON", chars: stdout.length });
    return { kind: "unknown" };
  }
  const status: AuthStatus = {
    kind: "ok",
    loggedIn: parsed.loggedIn === true,
    authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
    subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
  };
  log?.info("auth.status", { loggedIn: status.loggedIn, authMethod: status.authMethod, subscriptionType: status.subscriptionType });
  return status;
}

/** "5h N% · 7d M%" in whole percents; a missing window is left out, so nothing known is "". */
export function formatUsage(info: Pick<UsageInfo, "fiveHour" | "sevenDay">): string {
  const parts: string[] = [];
  if (info.fiveHour) parts.push(`5h ${percent(info.fiveHour.utilization)}%`);
  if (info.sevenDay) parts.push(`7d ${percent(info.sevenDay.utilization)}%`);
  return parts.join(" · ");
}

/**
 * SPEC §3.6: a status other than allowed (`allowed_warning` is still allowed) blocks spawning until `resetsAt`.
 * Without a reset time nothing is blocked: claude then reports the limit itself, in its own words.
 */
export function isUsageBlocked(info: Pick<UsageInfo, "status" | "resetsAt"> | null, nowMs: number): boolean {
  if (!info || info.status.startsWith("allowed") || info.resetsAt === null) return false;
  return nowMs < info.resetsAt * 1000;
}

/** The reset as local clock time ("6:00 PM"), with the weekday ("Sat 6:00 PM") when it is not today. */
export function formatResetTime(resetsAtSec: number, nowMs: number, timeZone?: string): string {
  const at = new Date(resetsAtSec * 1000);
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone });
  const time = at.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const text = day(at) === day(new Date(nowMs)) ? time : `${at.toLocaleDateString("en-US", { timeZone, weekday: "short" })} ${time}`;
  // ICU puts a narrow no-break space before AM/PM.
  return text.replace(/\s/g, " ");
}

/** The card text for a turn not started because usage is blocked. */
export function usageBlockedMessage(resetsAtSec: number, nowMs: number, timeZone?: string): string {
  return `Usage limit reached. Resets at ${formatResetTime(resetsAtSec, nowMs, timeZone)}.`;
}

/** Rounds the decimal value: 0.285 is 29 %, not the 28 that 0.285 * 100 = 28.499… would give. */
function percent(utilization: number): number {
  return Math.round(Number((utilization * 100).toFixed(6)));
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim());
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
