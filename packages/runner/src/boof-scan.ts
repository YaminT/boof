/**
 * Scan mode: walk a target repo for boof `goal.boof.xml` units that are not yet
 * done and turn each into a pipeline task. Ordering respects `plan.boof.xml`
 * (order + depends-on) using boof-planner's next-goal semantics: a unit is
 * actionable once its dependencies are done. This is a UNIVERSAL tool — nothing
 * about any specific project is hardcoded; everything comes from the repo.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  currentStatus,
  GOAL_FILE,
  parseGoal,
  parsePlan,
  PLAN_FILE,
  type BoofGoal,
  type BoofPlan,
  type BoofStatus,
} from "@boof-runner/shared";

/** Directories never worth walking into. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".boof-runner-worktrees",
]);

/** A goal.boof.xml unit discovered on disk. */
export interface ScannedUnit {
  /** Stable id: the plan goal id when present, else the unit's relative dir. */
  id: string;
  /** Directory holding the goal file, relative to the repo root (POSIX-ish). */
  dir: string;
  /** goal.boof.xml path relative to the repo root. */
  goalPath: string;
  goal: BoofGoal;
  status: BoofStatus;
  /** Development order (from plan.boof.xml when present; else discovery order). */
  order: number;
  dependsOn: string[];
  /** True when at least one dependency is not yet done (blocked from starting). */
  blocked: boolean;
}

export interface ScanResult {
  units: ScannedUnit[];
  plan: BoofPlan | null;
}

async function walkGoalDirs(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const hasGoal = entries.some((e) => e.isFile() && e.name === GOAL_FILE);
  if (hasGoal) out.push(dir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    await walkGoalDirs(root, join(dir, e.name), out);
  }
}

/** Relative path with forward slashes so it matches plan.boof.xml `path` values. */
function relPosix(root: string, p: string): string {
  const r = relative(root, p);
  return sep === "/" ? r : r.split(sep).join("/");
}

/**
 * Walk `repoRoot`, parse every goal.boof.xml, and merge with plan.boof.xml (when
 * present) to compute per-unit order, dependencies and blocked state. Units are
 * returned sorted by order (which is topologically consistent with depends-on),
 * so processing them in list order respects dependencies.
 */
export async function scanRepo(repoRoot: string): Promise<ScanResult> {
  const dirs: string[] = [];
  await walkGoalDirs(repoRoot, repoRoot, dirs);

  // Load the plan record if present.
  let plan: BoofPlan | null = null;
  try {
    plan = parsePlan(await readFile(join(repoRoot, PLAN_FILE), "utf8"));
  } catch {
    plan = null;
  }
  const planByPath = new Map(plan?.goals.map((g) => [g.path, g]) ?? []);

  // Parse each goal file; skip files that fail to parse (invalid boof).
  interface Raw {
    dir: string;
    goalPath: string;
    goal: BoofGoal;
    status: BoofStatus;
  }
  const raws: Raw[] = [];
  for (const abs of dirs) {
    const dir = relPosix(repoRoot, abs) || ".";
    try {
      const goal = parseGoal(await readFile(join(abs, GOAL_FILE), "utf8"));
      raws.push({ dir, goalPath: `${dir === "." ? "" : dir + "/"}${GOAL_FILE}`, goal, status: currentStatus(goal) });
    } catch {
      // Not a valid goal file — ignore it.
    }
  }

  // Disk status wins over the plan's cached status; key by plan path.
  const statusByPath = new Map<string, BoofStatus>(raws.map((r) => [r.dir, r.status]));
  const statusById = new Map<string, BoofStatus>();
  for (const g of plan?.goals ?? []) {
    const s = statusByPath.get(g.path);
    if (s) statusById.set(g.id, s);
  }
  const doneId = (id: string): boolean => (statusById.get(id) ?? "plan") === "done";

  let fallbackOrder = (plan?.goals.length ?? 0) + 1;
  const units: ScannedUnit[] = raws.map((r) => {
    const pg = planByPath.get(r.dir);
    const dependsOn = pg?.dependsOn ?? [];
    return {
      id: pg?.id ?? r.dir,
      dir: r.dir,
      goalPath: r.goalPath,
      goal: r.goal,
      status: r.status,
      order: pg?.order ?? fallbackOrder++,
      dependsOn,
      blocked: dependsOn.some((dep) => !doneId(dep)),
    };
  });

  units.sort((a, b) => a.order - b.order || a.dir.localeCompare(b.dir));
  return { units, plan };
}

/**
 * Units that still need work (status !== done), ordered deps-first and with
 * blocked units (dependencies not yet done) sorted after unblocked ones so the
 * single-threaded runner starts with actionable work.
 */
export async function selectActionableUnits(repoRoot: string): Promise<ScannedUnit[]> {
  const { units } = await scanRepo(repoRoot);
  return units
    .filter((u) => u.status !== "done")
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      return a.order - b.order || a.dir.localeCompare(b.dir);
    });
}

/**
 * Build the developer prompt for a scanned unit: the goal.boof.xml is the whole
 * spec, TDD is mandatory, and the agent must not touch the goal/plan files
 * (boof-runner records status on completion).
 */
export function buildUnitPrompt(unit: ScannedUnit, repoRoot: string): string {
  const { goal } = unit;
  const absGoal = join(repoRoot, unit.goalPath);
  const absDir = join(repoRoot, unit.dir);
  const t = goal.progress.tests;
  const dos = goal.overal.rules.do.map((d) => `- ${d}`).join("\n") || "- (none specified)";
  const donts = goal.overal.rules.dont.map((d) => `- ${d}`).join("\n");

  const parts = [
    `# Implement boof unit: ${unit.id}`,
    "You are implementing a single unit of a boof-seeded project. Its goal.boof.xml " +
      "is the complete specification — implement the unit strictly from that file; you " +
      "need nothing outside it and this unit's directory.",
    `Goal file: ${absGoal}\nUnit directory: ${absDir}\nCurrent status: ${unit.status}`,
    `## Goal\n${goal.overal.goal}`,
    `## Stack\n${goal.overal.stack}`,
    `## Rules — Do\n${dos}`,
    donts ? `## Rules — Don't\n${donts}` : "",
    `## Tests (${t.strategy})\n- Technology: ${t.technology}\n- Run: ${t.run}` +
      (t.coverage ? `\n- Coverage: ${t.coverage}` : ""),
    "## How to work\n" +
      `- Follow the test strategy: write a failing test first, then implement until \`${t.run}\` is green.\n` +
      "- Keep changes within this unit's scope/directory unless the goal explicitly requires otherwise.\n" +
      "- Do NOT edit goal.boof.xml or plan.boof.xml — boof-runner records the unit's status when the task completes.",
  ];
  return parts.filter(Boolean).join("\n\n");
}
