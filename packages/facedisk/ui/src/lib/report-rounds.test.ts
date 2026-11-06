import { describe, expect, it } from "vitest";
import { splitRounds, verdictLabel, verdictTone } from "./report-rounds.js";

const report = [
  "#### Round 1 — CHANGES_REQUESTED",
  "Fix the null check.",
  "",
  "#### Round 2 — APPROVE",
  "Looks good.",
  "",
  "#### Round 1 — REJECT (iteration 2)",
  "Start over.",
].join("\n");

describe("splitRounds", () => {
  it("returns rounds newest first with verdict, round and body", () => {
    const rounds = splitRounds(report);
    expect(rounds.map((r) => [r.round, r.verdict, r.iteration])).toEqual([
      [1, "REJECT", 2],
      [2, "APPROVE", 1],
      [1, "CHANGES_REQUESTED", 1],
    ]);
    expect(rounds[1].text).toBe("Looks good.");
  });

  it("treats an unknown verdict as INVALID", () => {
    expect(splitRounds("#### Round 3 — ???\nx")[0].verdict).toBe("INVALID");
  });

  it("returns one block without round or verdict when the report has no rounds", () => {
    expect(splitRounds("The plan.")).toEqual([
      { round: null, verdict: null, iteration: 1, text: "The plan." },
    ]);
  });

  it("returns nothing for an empty report", () => {
    expect(splitRounds("  \n")).toEqual([]);
  });
});

describe("verdict words", () => {
  it("names and tones each verdict", () => {
    expect(verdictLabel("APPROVE")).toBe("approved");
    expect(verdictLabel("CHANGES_REQUESTED")).toBe("changes requested");
    expect(verdictLabel("REJECT")).toBe("rejected");
    expect(verdictLabel("INVALID")).toBe("no verdict");
    expect(verdictTone("APPROVE")).toBe("done");
    expect(verdictTone("REJECT")).toBe("failed");
    expect(verdictTone("CHANGES_REQUESTED")).toBe("neutral");
    expect(verdictTone("INVALID")).toBe("neutral");
  });
});
