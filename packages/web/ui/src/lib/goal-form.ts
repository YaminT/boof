import type { Goal, GoalInput } from "../api.js";

export interface GoalValues {
  title: string;
  id: string;
  dependsOn: string[];
  model: string;
  goal: string;
  stack: string;
  doRules: string;
  dontRules: string;
  strategy: string;
  technology: string;
  run: string;
  coverage: string;
}

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function goalValues(goal: Goal | null): GoalValues {
  return {
    title: goal?.title ?? "",
    id: goal?.id ?? "",
    dependsOn: goal ? [...goal.dependsOn] : [],
    model: goal?.model ?? "",
    goal: goal?.spec.goal ?? "",
    stack: goal?.spec.stack ?? "",
    doRules: goal?.spec.rules.do.join("\n") ?? "",
    dontRules: goal?.spec.rules.dont.join("\n") ?? "",
    strategy: goal?.spec.tests.strategy ?? "",
    technology: goal?.spec.tests.technology ?? "",
    run: goal?.spec.tests.run ?? "",
    coverage: goal?.spec.tests.coverage ?? "",
  };
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toGoalInput(v: GoalValues, existingId: string | null): GoalInput {
  return {
    id: existingId ?? (v.id.trim() || slugify(v.title)),
    title: v.title.trim(),
    dependsOn: v.dependsOn,
    ...(v.model.trim() ? { model: v.model.trim() } : {}),
    spec: {
      goal: v.goal.trim(),
      stack: v.stack.trim(),
      rules: { do: lines(v.doRules), dont: lines(v.dontRules) },
      tests: {
        strategy: v.strategy.trim(),
        technology: v.technology.trim(),
        run: v.run.trim(),
        ...(v.coverage.trim() ? { coverage: v.coverage.trim() } : {}),
      },
    },
  };
}

/** Mirrors GoalSpecSchema so problems show before the round trip. */
export function goalFormProblems(v: GoalValues, isNew: boolean, takenIds: string[]): string[] {
  const out: string[] = [];
  if (!v.title.trim()) out.push("Add a title.");
  if (isNew) {
    const id = v.id.trim() || slugify(v.title);
    if (id && !KEBAB.test(id)) out.push("Use lowercase letters, digits and dashes for the id.");
    else if (takenIds.includes(id)) out.push("Another goal already uses this id.");
  }
  if (!v.goal.trim()) out.push("Describe the goal.");
  if (!v.stack.trim()) out.push("Name the stack.");
  if (lines(v.doRules).length === 0) out.push("Add at least one rule under Do.");
  if (!v.strategy.trim() || !v.technology.trim() || !v.run.trim())
    out.push("Fill in the test strategy, technology and run command.");
  return out;
}

export function sameGoalValues(a: GoalValues, b: GoalValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What an open editor takes from the live plan. A clean form follows everything (this goal's
 * values and the plan version). A dirty form keeps its edits and still takes the version while
 * this goal itself is unchanged, since a save only replaces this goal and so cannot lose another
 * writer's work. When this goal changed, the version stays: the save must meet the conflict.
 */
export function followLive(o: { isNew: boolean; dirty: boolean; elsewhere: boolean }): {
  values: boolean;
  version: boolean;
} {
  if (!o.dirty) return { values: !o.isNew, version: true };
  return { values: false, version: o.isNew || !o.elsewhere };
}
