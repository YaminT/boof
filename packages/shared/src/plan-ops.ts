import { sameGoalContent } from "./plan-diff.js";
import type { Goal, GoalInputParsed, GoalStatus, Plan } from "./plan-schema.js";
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
 * A done goal whose content changed goes back to `develop` right away, so a harness sees that
 * work is open again without waiting for a sync. Other statuses are left alone.
 */
export function reopenDoneGoal(goal: Goal, at: string = nowIso()): Goal {
  return goal.status === "done"
    ? withGoalStatus(goal, "develop", `spec changed to revision ${goal.revision}`, at)
    : goal;
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
        tasks: [],
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
    if (input.status && input.status !== old.status) {
      return withGoalStatus(goal, input.status, "status set by a plan edit", at);
    }
    return changed ? reopenDoneGoal(goal, at) : goal;
  });
  if (opts.replace) return built;
  const ids = new Set(built.map((g) => g.id));
  return [...existing.filter((g) => !ids.has(g.id)), ...built];
}

/**
 * Record or clear the approval of `next`, the plan a trusted or local principal `by` is about to
 * save over `before` (undefined for a new plan). Going `active` from another status stamps
 * `approvedBy`; staying `active` keeps the existing approval; any other status clears it.
 */
export function withApproval(
  before: Plan | undefined,
  next: Plan,
  by: string,
  at: string = nowIso(),
): Plan {
  if (next.status !== "active") {
    const { approvedBy: _drop, ...rest } = next;
    return rest;
  }
  if (before?.status === "active" && before.approvedBy) {
    return { ...next, approvedBy: before.approvedBy };
  }
  return { ...next, approvedBy: { principalId: by, at, version: (before?.version ?? 0) + 1 } };
}
