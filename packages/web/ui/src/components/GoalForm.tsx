import { useState } from "react";
import type { Goal, GoalInput } from "../api.js";
import { Modal } from "./Modal.js";

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Add or edit one goal; the server validates the result and its errors show inline. */
export function GoalForm({
  goal,
  others,
  error,
  onSave,
  onClose,
}: {
  goal: Goal | null;
  /** Ids of the other goals, offered as dependencies. */
  others: string[];
  error: string[];
  onSave: (g: GoalInput) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [id, setId] = useState(goal?.id ?? "");
  const [deps, setDeps] = useState<string[]>(goal?.dependsOn ?? []);
  const [model, setModel] = useState(goal?.model ?? "");
  const [text, setText] = useState(goal?.spec.goal ?? "");
  const [stack, setStack] = useState(goal?.spec.stack ?? "");
  const [doRules, setDoRules] = useState(goal?.spec.rules.do.join("\n") ?? "");
  const [dontRules, setDontRules] = useState(goal?.spec.rules.dont.join("\n") ?? "");
  const [strategy, setStrategy] = useState(goal?.spec.tests.strategy ?? "");
  const [technology, setTechnology] = useState(goal?.spec.tests.technology ?? "");
  const [run, setRun] = useState(goal?.spec.tests.run ?? "");
  const [coverage, setCoverage] = useState(goal?.spec.tests.coverage ?? "");

  const submit = () =>
    onSave({
      id: goal ? goal.id : id || slug(title),
      title: title.trim(),
      dependsOn: deps,
      ...(model.trim() ? { model: model.trim() } : {}),
      spec: {
        goal: text.trim(),
        stack: stack.trim(),
        rules: { do: lines(doRules), dont: lines(dontRules) },
        tests: {
          strategy: strategy.trim(),
          technology: technology.trim(),
          run: run.trim(),
          ...(coverage.trim() ? { coverage: coverage.trim() } : {}),
        },
      },
    });

  return (
    <Modal title={goal ? `Edit goal ${goal.id}` : "Add goal"} onClose={onClose}>
      <form
        className="goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="goal-form-row">
          <label>
            Id (kebab-case)
            <input
              value={goal ? goal.id : id}
              disabled={!!goal}
              placeholder={slug(title)}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label>
            Model (optional)
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        </div>
        <label>
          Depends on
          <select
            multiple
            size={Math.min(5, Math.max(2, others.length))}
            value={deps}
            onChange={(e) => setDeps([...e.target.selectedOptions].map((o) => o.value))}
          >
            {others.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          Goal
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label>
          Stack
          <input value={stack} onChange={(e) => setStack(e.target.value)} />
        </label>
        <div className="goal-form-row">
          <label>
            Rules: do (one per line)
            <textarea rows={4} value={doRules} onChange={(e) => setDoRules(e.target.value)} />
          </label>
          <label>
            Rules: don&apos;t (one per line)
            <textarea rows={4} value={dontRules} onChange={(e) => setDontRules(e.target.value)} />
          </label>
        </div>
        <label>
          Test strategy
          <input value={strategy} onChange={(e) => setStrategy(e.target.value)} />
        </label>
        <div className="goal-form-row">
          <label>
            Test technology
            <input value={technology} onChange={(e) => setTechnology(e.target.value)} />
          </label>
          <label>
            Run command
            <input value={run} onChange={(e) => setRun(e.target.value)} />
          </label>
          <label>
            Coverage (optional)
            <input value={coverage} onChange={(e) => setCoverage(e.target.value)} />
          </label>
        </div>
        {error.map((m, i) => (
          <p key={i} className="error">
            {m}
          </p>
        ))}
        <div className="editor-actions">
          <button className="primary" type="submit" disabled={!title.trim()}>
            Save goal
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
