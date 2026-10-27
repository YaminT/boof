/** Pull the most recent "### Step" header out of the log as the current phase. */
export function currentStep(log: string): string | null {
  const matches = log.match(/^### (.+)$/gm);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].replace(/^### /, "");
}

/** Number of `### Steered` blocks: one is logged each time an "apply now" prompt takes effect. */
export function steeredCount(log: string): number {
  return (log.match(/^### Steered$/gm) ?? []).length;
}

/** The last `n` non-empty lines, trimmed on the right. */
export function tailLines(log: string, n: number): string[] {
  if (n <= 0) return [];
  const lines = log
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  return lines.slice(-n);
}
