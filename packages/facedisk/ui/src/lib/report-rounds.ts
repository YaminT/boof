import type { Tone } from "./status.js";

export type Verdict = "APPROVE" | "CHANGES_REQUESTED" | "REJECT" | "INVALID";

export type ReportBlock = {
  /** Null when the report has no round headers (planner, developer). */
  round: number | null;
  verdict: Verdict | null;
  iteration: number;
  text: string;
};

const VERDICTS = new Set<string>(["APPROVE", "CHANGES_REQUESTED", "REJECT"]);

/**
 * Splits a report into its `#### Round N — VERDICT (iteration K)` blocks, newest first. A report
 * without round headers is one block; an empty report has none.
 */
export function splitRounds(report: string): ReportBlock[] {
  const trimmed = report.trim();
  if (trimmed === "") return [];
  const blocks = trimmed
    .split(/(?=^#### Round )/m)
    .map((b) => b.trim())
    .filter((b) => b.startsWith("#### Round "));
  if (blocks.length === 0) return [{ round: null, verdict: null, iteration: 1, text: trimmed }];
  return blocks
    .map((block): ReportBlock => {
      const nl = block.indexOf("\n");
      const head = nl < 0 ? block : block.slice(0, nl);
      const m = /^#### Round (\d+)(?: — (\S+))?(?: \(iteration (\d+)\))?/.exec(head);
      return {
        round: Number(m?.[1] ?? 1),
        verdict: m?.[2] && VERDICTS.has(m[2]) ? (m[2] as Verdict) : "INVALID",
        iteration: Number(m?.[3] ?? 1),
        text: nl < 0 ? "" : block.slice(nl + 1).trim(),
      };
    })
    .reverse();
}

const LABELS: Record<Verdict, string> = {
  APPROVE: "approved",
  CHANGES_REQUESTED: "changes requested",
  REJECT: "rejected",
  INVALID: "no verdict",
};

export function verdictLabel(v: Verdict): string {
  return LABELS[v];
}

export function verdictTone(v: Verdict): Tone {
  return v === "APPROVE" ? "done" : v === "REJECT" ? "failed" : "neutral";
}
