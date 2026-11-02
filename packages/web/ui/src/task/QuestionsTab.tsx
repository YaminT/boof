import type { TaskView } from "../api.js";
import { AnswerBox } from "./AnswerBox.js";

const PROSE = "m-0 max-w-[80ch] text-[length:var(--text-body)] whitespace-pre-wrap";

/** The planner's questions and the earlier answers; a task waiting on the planner takes answers here. */
export function QuestionsTab({
  pid,
  task,
  reload,
}: {
  pid: string;
  task: TaskView;
  reload: () => Promise<void>;
}) {
  const { questions, answers: earlier } = task.body;
  const waiting = task.frontmatter.status === "action";

  if (!questions?.trim() && !earlier?.trim()) {
    return <p className="m-0 text-ink-muted">The planner has not asked anything for this task.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {questions?.trim() && (
        <section className="flex flex-col gap-1">
          <h3 className="m-0 text-[length:var(--text-body)] font-semibold">Questions</h3>
          <p className={PROSE}>{questions}</p>
        </section>
      )}
      {earlier?.trim() && (
        <section className="flex flex-col gap-1">
          <h3 className="m-0 text-[length:var(--text-body)] font-semibold">Earlier answers</h3>
          <p className={PROSE}>{earlier}</p>
        </section>
      )}
      {waiting && <AnswerBox pid={pid} taskId={task.frontmatter.id} onSent={reload} />}
    </div>
  );
}
