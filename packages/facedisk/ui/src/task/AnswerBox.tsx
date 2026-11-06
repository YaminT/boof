import { useId, useState } from "react";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { api } from "../api.js";
import { act } from "../lib/act.js";

/**
 * "Your answers" and "Send answers" for a task waiting on the planner. It answers in `pid`, the
 * task's own project, and keeps the typed text when sending fails.
 */
export function AnswerBox({
  pid,
  taskId,
  onSent,
}: {
  pid: string;
  taskId: string;
  onSent: () => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState("");
  const [sending, setSending] = useState(false);
  const labelId = useId();
  const send = async () => {
    setSending(true);
    const ok = await act(() => api.submitAnswers(pid, taskId, answers), {
      failure: "Could not send answers",
      success: "Answers sent",
    });
    setSending(false);
    if (ok) {
      setAnswers("");
      await onSent();
    }
  };
  return (
    <div className="flex max-w-[80ch] flex-col items-start gap-2">
      <div id={labelId} className="text-[length:var(--text-body)] font-medium">
        Your answers
      </div>
      <Textarea
        aria-labelledby={labelId}
        rows={6}
        value={answers}
        onChange={(e) => setAnswers(e.target.value)}
      />
      <Button onClick={() => void send()} disabled={sending || !answers.trim()}>
        Send answers
      </Button>
    </div>
  );
}
