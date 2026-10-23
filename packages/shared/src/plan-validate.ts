import { topoSort } from "./boof-goal.js";
import type { Goal, Plan } from "./plan-schema.js";

export interface PlanIssue {
  path: string;
  message: string;
}

/** A plan failed validation (duplicate ids, unknown dependencies, a cycle, a bad order). */
export class PlanValidationError extends Error {
  constructor(public readonly issues: PlanIssue[]) {
    super(
      `Invalid plan: ${issues.map((i) => (i.path ? `${i.path}: ` : "") + i.message).join("; ")}`,
    );
    this.name = "PlanValidationError";
  }
}

type GoalLike = Pick<Goal, "id" | "order" | "dependsOn">;

/**
 * Deterministic topological order that follows the existing `order` wherever the dependencies
 * allow it: among the goals whose dependencies are placed, the lowest (order, id) goes first.
 * The goals must be unique and acyclic with known dependencies (see {@link planIssues}).
 */
export function topologicalByOrder<T extends GoalLike>(goals: T[]): T[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const indegree = new Map(goals.map((g) => [g.id, g.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const g of goals) {
    for (const dep of g.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(g.id);
      dependents.set(dep, list);
    }
  }
  const cmp = (a: GoalLike, b: GoalLike) => a.order - b.order || (a.id < b.id ? -1 : 1);
  const ready = goals.filter((g) => g.dependsOn.length === 0).sort(cmp);
  const out: T[] = [];
  while (ready.length > 0) {
    const g = ready.shift()!;
    out.push(g as T);
    for (const next of dependents.get(g.id) ?? []) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) {
        ready.push(byId.get(next)!);
        ready.sort(cmp);
      }
    }
  }
  return out;
}

/** Re-number `order` 1..n following the topological order that is closest to the current one. */
export function normalizeOrder<T extends GoalLike>(goals: T[]): T[] {
  return topologicalByOrder(goals).map((g, i) => ({ ...g, order: i + 1 }));
}

/** Every structural problem of a goal list; empty when the DAG is valid. */
export function planIssues(goals: GoalLike[], opts: { checkOrder?: boolean } = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const ids = new Set<string>();
  goals.forEach((g, i) => {
    if (ids.has(g.id))
      issues.push({ path: `goals.${i}.id`, message: `duplicate goal id "${g.id}"` });
    ids.add(g.id);
  });
  goals.forEach((g, i) => {
    const seen = new Set<string>();
    for (const dep of g.dependsOn) {
      if (dep === g.id) {
        issues.push({ path: `goals.${i}.dependsOn`, message: `goal "${g.id}" depends on itself` });
      } else if (!ids.has(dep)) {
        issues.push({
          path: `goals.${i}.dependsOn`,
          message: `goal "${g.id}" depends on unknown goal "${dep}"`,
        });
      }
      if (seen.has(dep)) {
        issues.push({
          path: `goals.${i}.dependsOn`,
          message: `goal "${g.id}" lists "${dep}" twice`,
        });
      }
      seen.add(dep);
    }
  });
  if (issues.length > 0) return issues;
  try {
    topoSort(goals);
  } catch (err) {
    return [{ path: "goals", message: (err as Error).message }];
  }
  if (opts.checkOrder) {
    const order = new Map(goals.map((g) => [g.id, g.order]));
    goals.forEach((g, i) => {
      for (const dep of g.dependsOn) {
        if ((order.get(dep) ?? 0) >= g.order) {
          issues.push({
            path: `goals.${i}.order`,
            message: `goal "${g.id}" (order ${g.order}) must come after its dependency "${dep}" (order ${order.get(dep)})`,
          });
        }
      }
    });
  }
  return issues;
}

/**
 * Validate a plan: unique goal ids, dependencies that exist, no cycles, and an `order` that is
 * consistent with the dependencies. With `normalizeOrder` the order is re-numbered 1..n instead
 * of rejected. Returns the plan with its goals sorted by order; throws {@link PlanValidationError}.
 */
export function validatePlan(plan: Plan, opts: { normalizeOrder?: boolean } = {}): Plan {
  const issues = planIssues(plan.goals, { checkOrder: !opts.normalizeOrder });
  if (issues.length > 0) throw new PlanValidationError(issues);
  const goals = opts.normalizeOrder
    ? normalizeOrder(plan.goals)
    : [...plan.goals].sort((a, b) => a.order - b.order);
  return { ...plan, goals };
}

/** True when `orderedIds` lists every goal exactly once with each goal after its dependencies. */
export function isValidTopologicalOrder(goals: GoalLike[], orderedIds: string[]): boolean {
  if (orderedIds.length !== goals.length) return false;
  const position = new Map<string, number>();
  for (const [i, id] of orderedIds.entries()) {
    if (position.has(id)) return false;
    position.set(id, i);
  }
  return goals.every(
    (g) =>
      position.has(g.id) &&
      g.dependsOn.every((d) => (position.get(d) ?? Infinity) < position.get(g.id)!),
  );
}
