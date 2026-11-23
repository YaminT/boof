/** What Home shows for the running task: its title, else its id; never an empty string. */
export function runningLabel(
  title: string | null | undefined,
  id: string | undefined,
): string | null {
  return title?.trim() || id || null;
}

/** The marker of a queued task outside the queue order: blocked plan tasks wait, others are skipped. */
export function unorderedMarker(labels: readonly string[]): "waiting" | "skipped" {
  return labels.includes("blocked") ? "waiting" : "skipped";
}
