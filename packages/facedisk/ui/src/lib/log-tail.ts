/** Pull the most recent "### Step" header out of the log as the current phase. */
export function currentStep(log: string): string | null {
  const matches = log.match(/^### (.+)$/gm);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].replace(/^### /, "");
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

/** The `### ` step headers of a log, in order. */
export function stepHeaders(log: string): string[] {
  return [...log.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
}
