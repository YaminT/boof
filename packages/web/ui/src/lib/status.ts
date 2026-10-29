import type { Status } from "@boof-runner/shared/schema";

export type Tone = "neutral" | "running" | "attention" | "done" | "failed";

const LABELS: Record<Status, string> = {
  draft: "draft",
  pending: "queued",
  running: "running",
  action: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  archived: "archived",
};

/** The word shown in a status pill. */
export function statusLabel(status: Status): string {
  return LABELS[status];
}

export function statusTone(status: Status): Tone {
  switch (status) {
    case "running":
      return "running";
    case "action":
      return "attention";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "neutral";
  }
}
