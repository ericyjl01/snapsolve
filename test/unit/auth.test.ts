import { describe, expect, it, vi } from "vitest";
import {
  checkAuth,
  formatResetTime,
  formatUsage,
  isUsageBlocked,
  usageBlockedMessage,
  type ExecFileFn,
} from "../../src/main/auth";
import type { Logger } from "../../src/main/log";

const COMMAND = { path: "/opt/claude/bin/claude", prefixArgs: [] };
/** `claude auth status` as Claude Code 2.1 prints it (identity fields included). */
const STATUS = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "someone@example.com",
  orgId: "org-7f3a",
  orgName: "Example Org",
  subscriptionType: "team",
};

function recordingLog() {
  const lines: { level: string; event: string; fields?: unknown }[] = [];
  const at = (level: string) => (event: string, fields?: unknown) => void lines.push({ level, event, fields });
  const log: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), flush: async () => {} };
  return { log, lines, text: () => JSON.stringify(lines) };
}

/** An execFile that resolves with `stdout` (exit 0). */
const printing = (stdout: string): ExecFileFn => vi.fn(async () => ({ stdout, stderr: "" }));

/** An execFile that rejects the way util.promisify(execFile) does: `code` is the exit code or the errno string. */
function failing(code: number | string, stdout = ""): ExecFileFn {
  return vi.fn(async () => {
    throw Object.assign(new Error(`Command failed: claude auth status`), { code, stdout, stderr: "" });
  });
}

describe("checkAuth", () => {
  it("runs `<command> auth status` with the given env, hidden, under a timeout", async () => {
    const execFile = printing(JSON.stringify(STATUS));
    const env = { PATH: "/usr/bin" };
    await checkAuth({ execFile, command: { path: process.execPath, prefixArgs: ["fake.mjs"] }, env });
    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      ["fake.mjs", "auth", "status"],
      expect.objectContaining({ env, windowsHide: true, timeout: expect.any(Number) }),
    );
  });

  it("parses loggedIn true with authMethod and subscriptionType", async () => {
    const { log } = recordingLog();
    const status = await checkAuth({ execFile: printing(JSON.stringify(STATUS)), command: COMMAND, env: {}, log });
    expect(status).toEqual({ kind: "ok", loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" });
  });

  it("parses loggedIn false", async () => {
    const out = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    const status = await checkAuth({ execFile: printing(out), command: COMMAND, env: {} });
    expect(status).toEqual({ kind: "ok", loggedIn: false, authMethod: "none", subscriptionType: null });
  });

  it("a non-zero exit that still printed the JSON is read from its stdout: loggedIn false", async () => {
    const out = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    const status = await checkAuth({ execFile: failing(1, out), command: COMMAND, env: {} });
    expect(status).toEqual({ kind: "ok", loggedIn: false, authMethod: "none", subscriptionType: null });
  });

  it("anything but loggedIn === true counts as logged out", async () => {
    const status = await checkAuth({ execFile: printing(JSON.stringify({ loggedIn: "yes" })), command: COMMAND, env: {} });
    expect(status).toMatchObject({ kind: "ok", loggedIn: false });
  });

  it("ENOENT → claudeNotFound", async () => {
    const status = await checkAuth({ execFile: failing("ENOENT"), command: COMMAND, env: {} });
    expect(status).toEqual({ kind: "claudeNotFound" });
  });

  it.each([
    ["not JSON", "Logged in as someone@example.com"],
    ["empty", ""],
    ["a JSON array", "[1,2]"],
    ["JSON without loggedIn", JSON.stringify({ authMethod: "claude.ai" })],
  ])("malformed output (%s) → unknown, no throw", async (_name, stdout) => {
    const status = await checkAuth({ execFile: printing(stdout), command: COMMAND, env: {} });
    expect(status).toEqual({ kind: "unknown" });
  });

  it("a non-zero exit without JSON (e.g. killed at the timeout) → unknown, no throw", async () => {
    const status = await checkAuth({ execFile: failing(143), command: COMMAND, env: {} });
    expect(status).toEqual({ kind: "unknown" });
  });

  it("never returns or logs email, org id or org name", async () => {
    for (const execFile of [
      printing(JSON.stringify(STATUS)),
      failing(1, JSON.stringify({ ...STATUS, loggedIn: false })),
      printing(`not json ${STATUS.email} ${STATUS.orgName}`),
    ]) {
      const { log, lines, text } = recordingLog();
      const status = await checkAuth({ execFile, command: COMMAND, env: {}, log });
      const seen = JSON.stringify(status) + text();
      for (const secret of [STATUS.email, STATUS.orgId, STATUS.orgName, "email", "orgId", "orgName"]) {
        expect(seen).not.toContain(secret);
      }
      expect(lines.length).toBeGreaterThan(0);
    }
  });
});

describe("formatUsage", () => {
  it("shows both windows as whole percents", () => {
    expect(
      formatUsage({ fiveHour: { utilization: 0.12, resetsAt: 1 }, sevenDay: { utilization: 0.34, resetsAt: 2 } }),
    ).toBe("5h 12% · 7d 34%");
  });

  it("rounds to the nearest whole percent", () => {
    expect(
      formatUsage({ fiveHour: { utilization: 0.034, resetsAt: null }, sevenDay: { utilization: 0.995, resetsAt: null } }),
    ).toBe("5h 3% · 7d 100%");
    expect(formatUsage({ fiveHour: { utilization: 0.125, resetsAt: null }, sevenDay: null })).toBe("5h 13%");
    // 0.285 * 100 is 28.499… in floating point; the decimal value rounds up.
    expect(formatUsage({ fiveHour: { utilization: 0.285, resetsAt: null }, sevenDay: null })).toBe("5h 29%");
  });

  it("omits a missing window; nothing known → empty", () => {
    expect(formatUsage({ fiveHour: null, sevenDay: { utilization: 0.4, resetsAt: null } })).toBe("7d 40%");
    expect(formatUsage({ fiveHour: null, sevenDay: null })).toBe("");
  });
});

describe("isUsageBlocked", () => {
  const RESET = 1_791_996_600; // unix seconds
  const before = RESET * 1000 - 60_000;

  it("status allowed (or allowed_warning) → not blocked", () => {
    expect(isUsageBlocked({ status: "allowed", resetsAt: RESET }, before)).toBe(false);
    expect(isUsageBlocked({ status: "allowed_warning", resetsAt: RESET }, before)).toBe(false);
  });

  it("any other status → blocked until resetsAt", () => {
    expect(isUsageBlocked({ status: "rejected", resetsAt: RESET }, before)).toBe(true);
    expect(isUsageBlocked({ status: "rejected", resetsAt: RESET }, RESET * 1000)).toBe(false);
  });

  it("no reset time or no event yet → not blocked (claude reports the limit itself)", () => {
    expect(isUsageBlocked({ status: "rejected", resetsAt: null }, before)).toBe(false);
    expect(isUsageBlocked(null, before)).toBe(false);
  });
});

describe("reset time", () => {
  // 2026-10-17 18:00 UTC = 2026-10-17 11:00 in Los Angeles (PDT).
  const RESET = Date.UTC(2026, 9, 17, 18, 0) / 1000;

  it("formats the local time of day when the reset is today", () => {
    const now = Date.UTC(2026, 9, 17, 15, 30);
    expect(formatResetTime(RESET, now, "UTC")).toBe("6:00 PM");
    expect(formatResetTime(RESET, now, "America/Los_Angeles")).toBe("11:00 AM");
  });

  it("adds the weekday when the reset is on another local day", () => {
    const now = Date.UTC(2026, 9, 16, 15, 30);
    expect(formatResetTime(RESET, now, "UTC")).toBe("Sat 6:00 PM");
  });

  it("the blocked message names the reset time", () => {
    expect(usageBlockedMessage(RESET, Date.UTC(2026, 9, 17, 15, 30), "UTC")).toBe("Usage limit reached. Resets at 6:00 PM.");
  });
});
