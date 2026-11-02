import { describe, expect, it } from "vitest";
import { parseCount, parseToolLimits, parseUsd, toolLimitsText } from "./form-numbers.js";

describe("parseCount", () => {
  it("reads whole numbers and treats empty as unset", () => {
    expect(parseCount("0", 0)).toEqual({ ok: true, value: 0 });
    expect(parseCount(" 3 ", 1)).toEqual({ ok: true, value: 3 });
    expect(parseCount("", 1)).toEqual({ ok: true, value: undefined });
    expect(parseCount("  ", 1)).toEqual({ ok: true, value: undefined });
  });
  it("refuses anything else", () => {
    for (const [t, min] of [
      ["0", 1],
      ["1.5", 0],
      ["x", 0],
      ["-1", 0],
    ] as const)
      expect(parseCount(t, min)).toEqual({ ok: false });
  });
});

describe("parseUsd", () => {
  it("reads positive amounts and treats empty as no limit", () => {
    expect(parseUsd("2.5")).toEqual({ ok: true, value: 2.5 });
    expect(parseUsd("")).toEqual({ ok: true, value: undefined });
  });
  it("refuses zero, negatives and words", () => {
    for (const t of ["0", "-1", "abc", "Infinity"]) expect(parseUsd(t)).toEqual({ ok: false });
  });
});

describe("tool limits", () => {
  it("parses tool=USD lines and comma lists", () => {
    expect(parseToolLimits("codex=5\nclaude-code = 10")).toEqual({
      ok: true,
      value: { codex: 5, "claude-code": 10 },
    });
    expect(parseToolLimits("codex=5, opencode=1")).toEqual({
      ok: true,
      value: { codex: 5, opencode: 1 },
    });
  });
  it("refuses a bad entry and treats nothing as unset", () => {
    expect(parseToolLimits("codex")).toEqual({ ok: false });
    expect(parseToolLimits("codex=0")).toEqual({ ok: false });
    expect(parseToolLimits("  ")).toEqual({ ok: true, value: undefined });
  });
  it("prints one entry per line", () => {
    expect(toolLimitsText({ codex: 5, opencode: 1 })).toBe("codex=5\nopencode=1");
    expect(toolLimitsText(undefined)).toBe("");
  });
});
