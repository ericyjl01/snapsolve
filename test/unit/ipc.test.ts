import { describe, expect, it } from "vitest";
import { IPC, PRELOAD_CHANNELS } from "../../src/shared/ipc";

describe("IPC contract", () => {
  it("maps exactly the eleven preload functions (SPEC §4.4 + Amendments 2 and 9)", () => {
    expect(Object.keys(PRELOAD_CHANNELS).sort()).toEqual(
      [
        "onDelta",
        "onDone",
        "onThreadsChanged",
        "listThreads",
        "followUp",
        "retry",
        "hide",
        "openExternal",
        "clearHistory",
        "openScreenRecordingSettings",
        "relaunch",
      ].sort(),
    );
  });

  it("Copy is gone and the × hides the window instead (061)", () => {
    expect(Object.keys(PRELOAD_CHANNELS)).not.toContain("copy");
    expect(Object.values(IPC)).not.toContain("clipboard:copy");
    expect(Object.keys(PRELOAD_CHANNELS)).toContain("hide");
    expect(Object.values(IPC)).toContain("panel:hide");
  });

  it("channel names are area:verb and unique", () => {
    const names = Object.values(IPC);
    for (const n of names) expect(n).toMatch(/^[a-z]+:[a-z][A-Za-z]*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("each preload function has its own declared channel", () => {
    const declared = new Set<string>(Object.values(IPC));
    const used = Object.values(PRELOAD_CHANNELS);
    for (const c of used) expect(declared.has(c), c).toBe(true);
    expect(new Set(used).size).toBe(used.length);
  });
});
