import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError, type Goal, type Plan } from "../api.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { act } from "../lib/act.js";
import { conflictOf } from "../lib/conflict.js";
import {
  followLive,
  goalFormProblems,
  goalValues,
  sameGoalValues,
  slugify,
  toGoalInput,
  type GoalValues,
} from "../lib/goal-form.js";
import { planErrorLines } from "../lib/plan-view.js";

const label = "flex flex-col gap-1 text-[length:var(--text-row)] font-medium";

/**
 * Add or edit one goal in the side panel. It remembers the plan version and the goal it was
 * opened on, so a live reload never resets the fields; a save against a newer plan is a conflict
 * the user resolves with Reload or Overwrite.
 */
export function GoalEditor({
  pid,
  plan,
  goal,
  onSaved,
  onCancel,
}: {
  pid: string;
  plan: Plan;
  /** The live goal, or null to add one. */
  goal: Goal | null;
  onSaved: (goalId: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isNew = goal === null;
  const [baseVersion, setBaseVersion] = useState(plan.version);
  const [base, setBase] = useState<GoalValues>(() => goalValues(goal));
  const [values, setValues] = useState<GoalValues>(base);
  const [conflict, setConflict] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const noticeId = useId();
  const [tick, setTick] = useState(0);

  const live = useMemo(() => goalValues(goal), [goal]);
  const dirty = !sameGoalValues(values, base);
  const elsewhere = !isNew && !sameGoalValues(live, base);
  const others = plan.goals.filter((g) => g.id !== goal?.id);
  const problems = goalFormProblems(
    values,
    isNew,
    others.map((g) => g.id),
  );
  const set = <K extends keyof GoalValues>(k: K, v: GoalValues[K]) =>
    setValues((s) => ({ ...s, [k]: v }));

  // Follow the live plan as far as is safe (see followLive); a dirty form keeps its edits.
  useEffect(() => {
    const take = followLive({ isNew, dirty, elsewhere });
    if (take.values && elsewhere) {
      setBase(live);
      setValues(live);
    }
    if (take.version) {
      setBaseVersion(plan.version);
      // A 409 caused only by another goal's change is over once the version is current.
      if (!elsewhere) setConflict(false);
    }
  }, [live, plan.version]);

  useEffect(() => {
    if (tick > 0) noticeRef.current?.focus();
  }, [tick]);

  /** The plan as it is now: its version, and (when editing) this goal's current values. */
  const fresh = async () => {
    const p = await api.getPlan(pid, plan.id);
    return { version: p.version, goal: p.goals.find((g) => g.id === goal?.id) ?? null };
  };

  const save = async (version: number) => {
    const input = toGoalInput(values, goal?.id ?? null);
    setBusy(true);
    setLines([]);
    const saved = await act(() => api.putGoal(pid, { id: plan.id, version }, input), {
      failure: "Could not save the goal",
      success: "Goal saved",
      onError: (e) => {
        if (conflictOf(e) === "plan") {
          setConflict(true);
          setTick((n) => n + 1);
          return true;
        }
        if (e instanceof ApiError && e.code === "invalid_plan") {
          setLines(planErrorLines(e));
          return true;
        }
        return false;
      },
    });
    setBusy(false);
    if (saved) await onSaved(input.id);
  };

  const reload = async () => {
    const f = await act(fresh, { failure: "Could not reload the plan" });
    if (!f) return;
    if (!isNew && !f.goal) {
      setConflict(false);
      setLines(["This goal was deleted."]);
      return;
    }
    const next = goalValues(f.goal);
    setBase(next);
    setValues(next);
    setBaseVersion(f.version);
    setConflict(false);
    setLines([]);
    titleRef.current?.focus();
  };
  const overwrite = async () => {
    const f = await act(fresh, { failure: "Could not reload the plan" });
    if (!f) return;
    if (!isNew && !f.goal) {
      // Deleted elsewhere: saving would bring it back.
      setConflict(false);
      setLines(["This goal was deleted."]);
      return;
    }
    setConflict(false);
    await save(f.version);
  };

  return (
    <form
      aria-label={isNew ? "Add goal" : `Edit goal ${goal.title}`}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && problems.length === 0) void save(baseVersion);
      }}
    >
      <h2 className="m-0 text-[length:var(--text-section)] font-semibold">
        {isNew ? "Add goal" : "Edit goal"}
      </h2>
      <div
        ref={noticeRef}
        tabIndex={-1}
        role={conflict ? "alert" : "status"}
        aria-labelledby={noticeId}
        className={
          conflict || elsewhere
            ? "flex flex-wrap items-center gap-2 rounded-md border border-attention/40 bg-surface px-3 py-2 text-[length:var(--text-row)] text-attention outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            : "sr-only"
        }
      >
        {conflict ? (
          <>
            <span id={noticeId}>This plan changed after you opened the form.</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => void reload()}
            >
              Reload
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || problems.length > 0}
              onClick={() => void overwrite()}
            >
              Overwrite
            </Button>
          </>
        ) : elsewhere ? (
          <>
            <span id={noticeId}>This goal changed elsewhere.</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => void reload()}
            >
              Reload
            </Button>
          </>
        ) : null}
      </div>
      <label className={label}>
        Title
        <Input
          ref={titleRef}
          autoFocus
          className="mt-0 font-normal"
          value={values.title}
          onChange={(e) => set("title", e.target.value)}
        />
      </label>
      {isNew && (
        <label className={label}>
          Id
          <Input
            className="mt-0 font-mono font-normal"
            value={values.id}
            placeholder={slugify(values.title)}
            onChange={(e) => set("id", e.target.value)}
          />
        </label>
      )}
      <label className={label}>
        Model (optional)
        <Input
          className="mt-0 font-normal"
          value={values.model}
          onChange={(e) => set("model", e.target.value)}
        />
      </label>
      {others.length > 0 && (
        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-[length:var(--text-row)] font-medium">Depends on</legend>
          <div className="flex max-h-60 flex-col gap-1 overflow-auto rounded-md border border-line p-2">
            {others.map((g) => (
              <label key={g.id} className="check m-0 text-[length:var(--text-row)] font-normal">
                <input
                  type="checkbox"
                  checked={values.dependsOn.includes(g.id)}
                  onChange={(e) =>
                    set(
                      "dependsOn",
                      e.target.checked
                        ? [...values.dependsOn, g.id]
                        : values.dependsOn.filter((x) => x !== g.id),
                    )
                  }
                />
                {g.title}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className={label}>
        Goal
        <Textarea
          className="plain-font mt-0 font-normal"
          rows={3}
          value={values.goal}
          onChange={(e) => set("goal", e.target.value)}
        />
      </label>
      <label className={label}>
        Stack
        <Input
          className="mt-0 font-normal"
          value={values.stack}
          onChange={(e) => set("stack", e.target.value)}
        />
      </label>
      <label className={label}>
        Do (one rule per line)
        <Textarea
          className="plain-font mt-0 font-normal"
          rows={4}
          value={values.doRules}
          onChange={(e) => set("doRules", e.target.value)}
        />
      </label>
      <label className={label}>
        Don&apos;t (one rule per line)
        <Textarea
          className="plain-font mt-0 font-normal"
          rows={3}
          value={values.dontRules}
          onChange={(e) => set("dontRules", e.target.value)}
        />
      </label>
      <label className={label}>
        Test strategy
        <Input
          className="mt-0 font-normal"
          value={values.strategy}
          onChange={(e) => set("strategy", e.target.value)}
        />
      </label>
      <label className={label}>
        Test technology
        <Input
          className="mt-0 font-normal"
          value={values.technology}
          onChange={(e) => set("technology", e.target.value)}
        />
      </label>
      <label className={label}>
        Run command
        <Input
          className="mt-0 font-mono font-normal"
          value={values.run}
          onChange={(e) => set("run", e.target.value)}
        />
      </label>
      <label className={label}>
        Coverage (optional)
        <Input
          className="mt-0 font-normal"
          value={values.coverage}
          onChange={(e) => set("coverage", e.target.value)}
        />
      </label>
      {(dirty || isNew) && problems.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[length:var(--text-row)] text-ink-muted">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-0.5 text-[length:var(--text-row)] text-failed"
        >
          {lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || problems.length > 0}>
          Save goal
        </Button>
      </div>
    </form>
  );
}
