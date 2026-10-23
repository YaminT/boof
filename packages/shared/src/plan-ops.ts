import { sameGoalContent } from "./plan-diff.js";
import type { Goal, GoalInputParsed, GoalStatus } from "./plan-schema.js";
import { nowIso } from "./runtime.js";

/** Append a status entry to a goal's history and make it the goal's status. */
export function withGoalStatus(
  goal: Goal,
  status: GoalStatus,
  description: string,
  at: string = nowIso(),
): Goal {
  return {
    ...goal,
    status,
    history: [...goal.history, { revision: goal.revision, status, description, at }],
  };
}

/**
 * Turn client goals into stored goals. A goal that already exists keeps its history, taskId,
 * synced snapshot and (unless the client sets one) status; its `revision` goes up by one when
 * the spec, dependsOn or model changed. Title, path and order changes never bump the revision.
 *
 * `replace` returns exactly the given goals (the rest are dropped); otherwise the given goals
 * are upserted into `existing`, keeping the others.
 */
export function applyGoalInputs(
  existing: Goal[],
  inputs: GoalInputParsed[],
  opts: { replace: boolean; at?: string },
): Goal[] {
  const at = opts.at ?? nowIso();
  const stored = new Map(existing.map((g) => [g.id, g]));
  let nextOrder = existing.reduce((m, g) => Math.max(m, g.order), 0) + 1;
  const built = inputs.map((input, index): Goal => {
    const old = stored.get(input.id);
    const model = input.model;
    if (!old) {
      const order = input.order ?? (opts.replace ? index + 1 : nextOrder++);
      const status = input.status ?? "plan";
      return {
        id: input.id,
        title: input.title,
        ...(input.path ? { path: input.path } : {}),
        order,
        dependsOn: input.dependsOn,
        status,
        ...(model ? { model } : {}),
        spec: input.spec,
        revision: 1,
        taskId: null,
        history:
          status === "plan"
            ? []
            : [{ revision: 1, status, description: "status set when the goal was added", at }],
      };
    }
    const changed = !sameGoalContent(
      { spec: old.spec, dependsOn: old.dependsOn, model: old.model },
      { spec: input.spec, dependsOn: input.dependsOn, model },
    );
    const goal: Goal = {
      ...old,
      title: input.title,
      order: input.order ?? old.order,
      dependsOn: input.dependsOn,
      spec: input.spec,
      revision: changed ? old.revision + 1 : old.revision,
    };
    if (input.path) goal.path = input.path; // omitted: the stored path stays
    if (model) goal.model = model;
    else delete goal.model;
    return input.status && input.status !== old.status
      ? withGoalStatus(goal, input.status, "status set by a plan edit", at)
      : goal;
  });
  if (opts.replace) return built;
  const ids = new Set(built.map((g) => g.id));
  return [...existing.filter((g) => !ids.has(g.id)), ...built];
}
