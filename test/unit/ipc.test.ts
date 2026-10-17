import { describe, expect, it } from "vitest";
import { IPC, PRELOAD_CHANNELS } from "../../src/shared/ipc";

describe("IPC contract", () => {
  it("maps exactly the nine SPEC §4.4 preload functions", () => {
    expect(Object.keys(PRELOAD_CHANNELS).sort()).toEqual(
      [
        "onDelta",
        "onDone",
        "onThreadsChanged",
        "listThreads",
        "followUp",
        "retry",
        "copy",
        "openExternal",
        "clearHistory",
      ].sort(),
    );
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
