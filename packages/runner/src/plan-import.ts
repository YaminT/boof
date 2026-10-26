/**
 * Import a repository's goal.boof.xml / plan.boof.xml files into plan goals (plan model, import).
 * Built on {@link scanRepo}; pure apart from reading the repository.
 */
import {
  historyFromBoofGoal,
  nowIso,
  sameGoalContent,
  specFromBoofGoal,
  toKebabId,
  uniqueKebabId,
  reopenDoneGoal,
  withGoalStatus,
  type Goal,
  type GoalStatus,
} from "@boof-runner/shared";
import { scanRepo, type ScanResult } from "./boof-scan.js";

export interface ImportedGoals {
  goals: Goal[];
  /** Things the import could not carry over faithfully (dropped dependencies, renamed ids). */
  warnings: string[];
}

/** Goals of a scan: `path`, `order`, `dependsOn`, `status` from disk, `spec` and `history` from the goal file. */
export function goalsFromScan(scan: ScanResult, at: string = nowIso()): ImportedGoals {
  const warnings: string[] = [];
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  for (const u of scan.units) {
    const id = uniqueKebabId(toKebabId(u.id) || "goal", used);
    used.add(id);
    idOf.set(u.id, id);
    if (id !== u.id) warnings.push(`unit "${u.id}" imported with goal id "${id}"`);
  }
  const goals = scan.units.map((u): Goal => {
    const dependsOn: string[] = [];
    for (const dep of u.dependsOn) {
      const mapped = idOf.get(dep);
      if (mapped) dependsOn.push(mapped);
      else warnings.push(`goal "${u.id}" depends on "${dep}", which has no goal file; dropped`);
    }
    return {
      id: idOf.get(u.id)!,
      title: u.id,
      path: u.dir,
      order: u.order,
      dependsOn,
      status: u.status,
      ...(u.goal.model ? { model: u.goal.model } : {}),
      spec: specFromBoofGoal(u.goal),
      revision: 1,
      taskId: null,
      tasks: [],
      history: historyFromBoofGoal(u.goal, at),
    };
  });
  return { goals, warnings };
}

/** Scan `repoRoot` and convert what is found. */
export async function importFromRepo(repoRoot: string, at?: string): Promise<ImportedGoals> {
  return goalsFromScan(await scanRepo(repoRoot), at);
}

const RANK: Record<GoalStatus, number> = { plan: 0, develop: 1, review: 2, done: 3 };

export interface MergeResult {
  goals: Goal[];
  added: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * Merge freshly imported goals into a stored plan, matching by `path` and then by id. A matched
 * goal takes the repository's title, order and dependencies; its revision goes up when the spec,
 * dependencies or model changed. The repository's status is adopted only when it is further
 * along than the plan's (a repo that was not written back must not re-open finished goals).
 * Stored goals that are not in the repository stay.
 */
export function mergeImportedGoals(
  existing: Goal[],
  imported: Goal[],
  at: string = nowIso(),
): MergeResult {
  const taken = new Set(existing.map((g) => g.id));
  const finalId = new Map<string, string>();
  const match = new Map<string, Goal>();
  for (const imp of imported) {
    const old =
      existing.find((g) => imp.path !== undefined && g.path === imp.path) ??
      existing.find((g) => g.id === imp.id);
    if (old && ![...match.values()].includes(old)) {
      match.set(imp.id, old);
      finalId.set(imp.id, old.id);
    } else {
      const id = taken.has(imp.id) ? uniqueKebabId(imp.id, taken) : imp.id;
      taken.add(id);
      finalId.set(imp.id, id);
    }
  }
  const remap = (deps: string[]) => deps.map((d) => finalId.get(d) ?? d);

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const merged = new Map(existing.map((g) => [g.id, g]));
  for (const imp of imported) {
    const id = finalId.get(imp.id)!;
    const old = match.get(imp.id);
    const dependsOn = remap(imp.dependsOn);
    if (!old) {
      merged.set(id, { ...imp, id, dependsOn });
      added.push(id);
      continue;
    }
    const content = { spec: imp.spec, dependsOn, model: imp.model };
    const changed = !sameGoalContent(
      { spec: old.spec, dependsOn: old.dependsOn, model: old.model },
      content,
    );
    let goal: Goal = {
      ...old,
      title: imp.title,
      order: imp.order,
      dependsOn,
      spec: imp.spec,
      revision: changed ? old.revision + 1 : old.revision,
    };
    if (imp.path) goal.path = imp.path;
    if (imp.model) goal.model = imp.model;
    else delete goal.model;
    if (changed) goal = reopenDoneGoal(goal, at);
    const moved = RANK[imp.status] > RANK[old.status];
    if (moved) goal = withGoalStatus(goal, imp.status, "status synced from the repository", at);
    merged.set(id, goal);
    (changed || moved ? updated : unchanged).push(id);
  }
  return { goals: [...merged.values()], added, updated, unchanged };
}
