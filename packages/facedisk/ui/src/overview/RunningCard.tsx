import { useState } from "react";
import { Button } from "@/ui/button";
import { api, type TaskView } from "../api.js";
import { act } from "../lib/act.js";
import { currentStep, tailLines } from "../lib/log-tail.js";
import { formatRoute } from "../lib/route.js";
import { formatDuration } from "../lib/run-timing.js";
import { StopTaskDialog } from "../shell/StopTaskDialog.js";
import { SteerBox } from "./SteerBox.js";
import { useElapsed } from "./useElapsed.js";
import { useLiveLog } from "./useLiveLog.js";

/** One running task: step, elapsed time, the tail of its log, a steer box and Stop. */
export function RunningCard({
  pid,
  task,
  onChange,
}: {
  pid: string;
  task: TaskView;
  onChange: () => void;
}) {
  const id = task.frontmatter.id;
  const { log, failed: logFailed } = useLiveLog(pid, id, true);
  const [confirmStop, setConfirmStop] = useState(false);
  const elapsed = useElapsed(pid, task, true);

  const step = currentStep(log);
  const tail = tailLines(log, 6);
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-[7px] size-2 shrink-0 rounded-full bg-running motion-safe:animate-pulse"
        />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 truncate text-[length:var(--text-body)] font-semibold">
            {task.frontmatter.title}
          </h3>
          <p className="m-0 text-[length:var(--text-meta)] text-ink-muted">
            {step ? `${step}, ` : ""}
            running {elapsed !== null ? formatDuration(elapsed) : ""}
          </p>
        </div>
        <a
          href={formatRoute({ name: "task", pid, taskId: id, view: "edit" })}
          className="shrink-0 text-[length:var(--text-row)]"
        >
          Open
        </a>
      </div>

      <pre
        aria-label="Latest live output"
        className="mt-3 mb-0 min-h-[6.5rem] overflow-hidden rounded-md border border-line bg-page px-3 py-2 font-mono text-[length:var(--text-meta)] leading-[1.4] break-words whitespace-pre-wrap text-ink"
      >
        {logFailed
          ? "Live output unavailable. Retrying…"
          : tail.length > 0
            ? tail.join("\n")
            : "Waiting for output…"}
      </pre>

      <div className="mt-3">
        <SteerBox pid={pid} taskId={id} onSent={onChange}>
          <Button type="button" variant="destructive" onClick={() => setConfirmStop(true)}>
            Stop
          </Button>
        </SteerBox>
      </div>

      <StopTaskDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        onConfirm={() => {
          setConfirmStop(false);
          void act(() => api.stopTask(pid, id), {
            success: "Stop requested",
            failure: "Could not stop",
          }).then(onChange);
        }}
      />
    </section>
  );
}
