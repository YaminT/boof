import { useState } from "react";
import { api } from "../api.js";
import type { Task } from "../types.js";

function AnswerCard({ task, onChange }: { task: Task; onChange: () => void }) {
  const [answers, setAnswers] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.submitAnswers(task.frontmatter.id, answers);
      onChange();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="action-card">
      <h3>{task.frontmatter.title}</h3>
      <div className="questions">
        <h4>Questions</h4>
        <pre>{task.body.questions || "(no questions text)"}</pre>
      </div>
      <label className="prompt-field">
        Your answers
        <textarea value={answers} onChange={(e) => setAnswers(e.target.value)} rows={6} />
      </label>
      <button className="primary" onClick={submit} disabled={submitting || !answers.trim()}>
        Submit answers & resume
      </button>
    </div>
  );
}

export function ActionsTab({ tasks, onChange }: { tasks: Task[]; onChange: () => void }) {
  const parked = tasks.filter((t) => t.frontmatter.questions === "pending");
  if (parked.length === 0) {
    return <p className="empty">No tasks are waiting for answers.</p>;
  }
  return (
    <div className="actions-tab">
      {parked.map((t) => (
        <AnswerCard key={t.frontmatter.id} task={t} onChange={onChange} />
      ))}
    </div>
  );
}
