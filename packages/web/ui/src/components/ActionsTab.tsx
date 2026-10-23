import { useState } from "react";
import { api, type TaskView } from "../api.js";
import type { Project } from "@boof-runner/shared/schema";

function AnswerCard({
  task,
  projectName,
  onChange,
}: {
  task: TaskView;
  projectName: string;
  onChange: () => void;
}) {
  const [answers, setAnswers] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Answer in the project that owns the task, not the selected one.
      await api.submitAnswers(task.projectId, task.frontmatter.id, answers);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="action-card">
      <h3>
        {task.frontmatter.title} <span className="project-tag">{projectName}</span>
      </h3>
      <div className="questions">
        <h4>Questions</h4>
        <pre>{task.body.questions || "(no questions text)"}</pre>
      </div>
      <label className="prompt-field">
        Your answers
        <textarea value={answers} onChange={(e) => setAnswers(e.target.value)} rows={6} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" onClick={submit} disabled={submitting || !answers.trim()}>
        Submit answers & resume
      </button>
    </div>
  );
}

/** Parked tasks from every project the key can read (GET /api/actions). */
export function ActionsTab({
  actions,
  projects,
  onChange,
}: {
  actions: TaskView[];
  projects: Project[];
  onChange: () => void;
}) {
  if (actions.length === 0) {
    return <p className="empty">No tasks are waiting for answers.</p>;
  }
  const nameOf = (pid: string) => projects.find((p) => p.id === pid)?.name ?? pid;
  return (
    <div className="actions-tab">
      {actions.map((t) => (
        <AnswerCard
          key={`${t.projectId}/${t.frontmatter.id}`}
          task={t}
          projectName={nameOf(t.projectId)}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
