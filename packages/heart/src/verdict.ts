/** Final-line verdict emitted by the observer and reviewer. */
export type Verdict = "APPROVE" | "CHANGES_REQUESTED" | "REJECT";

const VERDICT_LINE = /^VERDICT:\s*(APPROVE|CHANGES_REQUESTED|REJECT)\s*$/;

/** Trim whitespace and markdown emphasis characters (`*`, `_`, backtick) around a line. */
function normalize(line: string): string {
  return line.replace(/^[\s*_`]+|[\s*_`]+$/g, "");
}

/**
 * Parse the verdict from a report. Case-sensitive and fail-closed (null):
 * - the last non-empty line must be an exact verdict line;
 * - identical repeated verdict lines are fine;
 * - any other exact verdict line anywhere in the report with a different
 *   verdict makes the result null;
 * - lines that merely mention `VERDICT:` (quoted protocol text) are ignored
 *   unless they are in the trailing run of `VERDICT:` lines.
 */
export function parseVerdict(report: string): Verdict | null {
  const lines = report.split("\n").map(normalize);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;

  let verdict: Verdict | null = null;
  for (let i = lines.length - 1; i >= 0 && lines[i]!.startsWith("VERDICT:"); i--) {
    const m = VERDICT_LINE.exec(lines[i]!);
    if (!m) return null;
    const v = m[1] as Verdict;
    if (verdict !== null && verdict !== v) return null;
    verdict = v;
  }
  if (verdict === null) return null;

  for (const line of lines) {
    const m = VERDICT_LINE.exec(line);
    if (m && m[1] !== verdict) return null;
  }
  return verdict;
}
