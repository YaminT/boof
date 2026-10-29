import type { TaskView } from "../api.js";
import { SteerBox } from "../overview/SteerBox.js";
import { LiveLog } from "./LiveLog.js";
import { ReportList } from "./ReportList.js";

/** The run of a task: its log, the reports of each role, and a steer box while it runs. */
export function RunTab({
  pid,
  task,
  reload,
}: {
  pid: string;
  task: TaskView;
  reload: () => Promise<void>;
}) {
  const id = task.frontmatter.id;
  const running = task.frontmatter.status === "running";
  return (
    <div className="flex flex-col gap-4">
      <LiveLog pid={pid} taskId={id} text={task.body.log} running={running} />
      <ReportList task={task} />
      {running && <SteerBox pid={pid} taskId={id} onSent={() => void reload()} />}
    </div>
  );
}
