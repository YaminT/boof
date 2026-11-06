import { useState } from "react";
import type { TaskView } from "../api.js";
import { ChangesPanel } from "../components/ChangesPanel.js";
import { useLive } from "../useLive.js";

/** What the task's branch changed, or why there is nothing to show yet. */
export function ChangesTab({ pid, task }: { pid: string; task: TaskView }) {
  const id = task.frontmatter.id;
  // Bumped on live events so the diff refreshes while the task runs.
  const [tick, setTick] = useState(0);
  useLive({
    onChanged: () => setTick((n) => n + 1),
    onEvent: (e) => {
      if (e.task === id) setTick((n) => n + 1);
    },
  });
  if (!task.branch) {
    return (
      <p className="m-0 text-ink-muted">
        No branch yet. The developer step creates one when it first commits.
      </p>
    );
  }
  return <ChangesPanel projectId={pid} taskId={id} status={task.frontmatter.status} tick={tick} />;
}
