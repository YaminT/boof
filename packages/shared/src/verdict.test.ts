import { describe, expect, it } from "vitest";
import { parseVerdict } from "./verdict.js";

describe("parseVerdict", () => {
  it.each(["APPROVE", "CHANGES_REQUESTED", "REJECT"] as const)("parses %s", (v) => {
    expect(parseVerdict(`# Report\n\nfindings\n\nVERDICT: ${v}`)).toBe(v);
  });

  it("ignores trailing whitespace and markdown emphasis", () => {
    expect(parseVerdict("x\n**VERDICT: APPROVE**  ")).toBe("APPROVE");
    expect(parseVerdict("x\n`VERDICT: REJECT`")).toBe("REJECT");
    expect(parseVerdict("x\n_VERDICT: CHANGES_REQUESTED_")).toBe("CHANGES_REQUESTED");
  });

  it("allows trailing blank lines", () => {
    expect(parseVerdict("x\nVERDICT: APPROVE\n\n  \n")).toBe("APPROVE");
  });

  it("is case-sensitive", () => {
    expect(parseVerdict("verdict: approve")).toBeNull();
    expect(parseVerdict("VERDICT: approve")).toBeNull();
  });

  it("fails closed on missing or malformed verdicts", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("Looks good.")).toBeNull();
    expect(parseVerdict("VERDICT: MAYBE")).toBeNull();
    expect(parseVerdict("VERDICT: APPROVE please")).toBeNull();
  });

  it("fails closed on conflicting final lines", () => {
    expect(parseVerdict("VERDICT: APPROVE\nVERDICT: REJECT")).toBeNull();
    expect(parseVerdict("VERDICT: REJECT\nVERDICT: APPROVE")).toBeNull();
    expect(parseVerdict("VERDICT: APPROVE\nVERDICT: MAYBE")).toBeNull();
  });

  it("accepts identical repeated final lines", () => {
    expect(parseVerdict("VERDICT: APPROVE\nVERDICT: APPROVE")).toBe("APPROVE");
  });

  it("ignores a verdict that is not on the final line", () => {
    expect(parseVerdict("VERDICT: APPROVE\nbut actually there is more")).toBeNull();
    expect(parseVerdict("VERDICT: APPROVE\n\nVERDICT: REJECT")).toBe("REJECT");
    expect(parseVerdict("quoted VERDICT: APPROVE inside a line")).toBeNull();
  });
});
