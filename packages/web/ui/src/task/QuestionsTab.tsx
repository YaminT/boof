import { useState } from "react";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { api, type TaskView } from "../api.js";
import { act } from "../lib/act.js";

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
  const [answers, setAnswers] = useState("");
  const [sending, setSending] = useState(false);
  const { questions, answers: earlier } = task.body;
  const waiting = task.frontmatter.status === "action";

  if (!questions?.trim() && !earlier?.trim()) {
    return <p className="m-0 text-ink-muted">The planner has not asked anything for this task.</p>;
  }

  const send = async () => {
    setSending(true);
    const ok = await act(() => api.submitAnswers(pid, task.frontmatter.id, answers), {
      failure: "Could not send answers",
      success: "Answers sent",
    });
    setSending(false);
    if (ok) {
      setAnswers("");
      await reload();
    }
  };

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
      {waiting && (
        <div className="flex max-w-[80ch] flex-col items-start gap-2">
          <div id="answers-label" className="text-[length:var(--text-body)] font-medium">
            Your answers
          </div>
          <Textarea
            aria-labelledby="answers-label"
            rows={6}
            value={answers}
            onChange={(e) => setAnswers(e.target.value)}
          />
          <Button onClick={() => void send()} disabled={sending || !answers.trim()}>
            Send answers
          </Button>
        </div>
      )}
    </div>
  );
}
