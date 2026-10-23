import { describe, expect, it } from "vitest";
import { modelName } from "../../src/shared/models";

// 086 (Amendment 20): each answer's footer names the model claude reported for it.
describe("modelName", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-5-5", "Haiku 5.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-sonnet-5-5[1m]", "Sonnet 5.5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-opus-4-1-20250805", "Opus 4.1"],
  ])("%s → %s", (id, name) => {
    expect(modelName(id)).toBe(name);
  });

  it.each([
    ["opus", "opus"],
    ["gpt-x", "gpt-x"],
    ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20241022"],
    ["claude-", "claude-"],
  ])("anything else is shown as given: %s → %s", (id, name) => {
    expect(modelName(id)).toBe(name);
  });

  it("a trailing context tag is dropped from any name", () => {
    expect(modelName("opus[1m]")).toBe("opus");
  });

  it("an empty or blank name stays as given", () => {
    expect(modelName("")).toBe("");
  });
});
