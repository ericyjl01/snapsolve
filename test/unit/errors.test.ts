import { describe, expect, it } from "vitest";
import { ERROR_KINDS, type ErrorKind, SnapsolveError, userMessage } from "../../src/shared/errors";

describe("error kinds", () => {
  it("cover every SPEC §7.1 condition", () => {
    expect(ERROR_KINDS).toEqual(
      expect.arrayContaining([
        "claudeNotFound",
        "notLoggedIn",
        "apiKeyInUse",
        "usageLimit",
        "timeout",
        "resumeFailed",
        "screenRecordingDenied",
        "hotkeyTaken",
      ]),
    );
  });

  it("are unique", () => {
    expect(new Set(ERROR_KINDS).size).toBe(ERROR_KINDS.length);
  });

  it("every kind has a non-empty user message", () => {
    for (const kind of ERROR_KINDS) {
      expect(userMessage(kind).trim(), kind).not.toBe("");
    }
  });
});

describe("userMessage", () => {
  it("claudeNotFound is exactly the SPEC §7.1 text", () => {
    expect(userMessage("claudeNotFound")).toBe("Claude Code not found. Run /snapsolve install.");
  });

  it("notLoggedIn is exactly the SPEC §7.1 text", () => {
    expect(userMessage("notLoggedIn")).toBe("Run `claude` once and log in.");
  });

  it("an unknown kind (e.g. from a stale renderer) falls back to the internal message", () => {
    expect(userMessage("noSuchKind" as ErrorKind)).toBe(userMessage("internal"));
  });
});

describe("SnapsolveError", () => {
  it("keeps kind and cause, and defaults its message to the user message", () => {
    const cause = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const e = new SnapsolveError("claudeNotFound", undefined, { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SnapsolveError);
    expect(e.name).toBe("SnapsolveError");
    expect(e.kind).toBe("claudeNotFound");
    expect(e.cause).toBe(cause);
    expect(e.message).toBe(userMessage("claudeNotFound"));
  });

  it("takes an explicit developer-facing message", () => {
    const e = new SnapsolveError("timeout", "turn exceeded 180 s");
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe("turn exceeded 180 s");
    expect(e.cause).toBeUndefined();
  });
});
