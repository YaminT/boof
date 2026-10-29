import { CheckIcon } from "lucide-react";
import type { TaskView } from "../api.js";
import { cn } from "@/lib/utils";
import { formatDuration, runLabel, stepStrip, type StepSegment } from "../lib/run-timing.js";
import { TonePill } from "../shell/StatusPill.js";

const ROLE_NAME: Record<StepSegment["role"], string> = {
  planner: "Planner",
  developer: "Developer",
  observer: "Observer",
  reviewer: "Reviewer",
};

function Segment({ seg }: { seg: StepSegment }) {
  return (
    <li
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border px-3 py-2 text-[length:var(--text-row)]",
        seg.state === "current" ? "border-running/50 bg-surface" : "border-line bg-surface",
        seg.state === "upcoming" && "text-ink-muted",
      )}
      aria-current={seg.state === "current" ? "step" : undefined}
    >
      {seg.state === "done" && (
        <CheckIcon className="size-3.5 text-done" role="img" aria-label="done" />
      )}
      {seg.state === "current" && (
        <span
          role="img"
          aria-label="running"
          className="size-1.5 rounded-full bg-running motion-safe:animate-pulse"
        />
      )}
      <span className="font-medium">{ROLE_NAME[seg.role]}</span>
      {seg.verdict && (
        <TonePill tone={seg.verdict === "approve" ? "done" : "failed"}>
          {seg.verdict === "approve" ? "approved" : "changes requested"}
        </TonePill>
      )}
      {seg.round > 1 && <span className="text-ink-muted">round {seg.round}</span>}
      {seg.seconds !== null && (
        <span className="ml-auto text-ink-muted tabular-nums">{formatDuration(seg.seconds)}</span>
      )}
    </li>
  );
}

/** The current run as four steps: who is done, who works now, who waits. */
export function StepStrip({
  task,
  now,
  logHeaders,
}: {
  task: TaskView;
  now: number;
  logHeaders: string[];
}) {
  const segments = stepStrip(task, now, logHeaders);
  const label = runLabel(task);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ol className="m-0 grid min-w-0 flex-1 list-none grid-cols-2 gap-2 p-0 min-[720px]:grid-cols-4">
        {segments.map((s) => (
          <Segment key={s.role} seg={s} />
        ))}
      </ol>
      {label && <span className="text-[length:var(--text-row)] text-ink-muted">{label}</span>}
    </div>
  );
}
