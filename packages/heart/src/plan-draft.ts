/**
 * Plan-draft result (wizard server): the agent's report ends in one fenced ```json block with the
 * goals of a plan. This module parses and validates that block (it is only ever data) and turns
 * it into goal inputs that carry the plan's shared fields.
 */
import { z } from "zod";
import { KebabIdSchema as kebab } from "./schema.js";
import { uniqueKebabId } from "./ids.js";
import type { GoalInputParsed } from "./plan-schema.js";
import { applyGoalInputs } from "./plan-ops.js";
import { PlanStore, PlanVersionConflict } from "./plan-store.js";

export const MAX_DRAFT_GOALS = 40;

export const DraftGoalSchema = z.strictObject({
  id: kebab,
  title: z.string().trim().min(1).max(200),
  details: z.string().max(4000).default(""),
  dependsOn: z.array(kebab).default([]),
});
export type DraftGoal = z.infer<typeof DraftGoalSchema>;

export const DraftGoalsSchema = z
  .strictObject({ goals: z.array(DraftGoalSchema).min(1).max(MAX_DRAFT_GOALS) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.goals.forEach((goal, index) => {
      if (seen.has(goal.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate goal id ${goal.id}`,
          path: ["goals", index, "id"],
        });
      }
      goal.dependsOn.forEach((dep, depIndex) => {
        if (!seen.has(dep)) {
          ctx.addIssue({
            code: "custom",
            message: `${goal.id} depends on ${dep}, which is not an earlier goal`,
            path: ["goals", index, "dependsOn", depIndex],
          });
        }
      });
      seen.add(goal.id);
    });
  });
export type DraftGoals = z.infer<typeof DraftGoalsSchema>;

export class PlanDraftParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanDraftParseError";
  }
}

/** The text of the last fenced ```json block of a report, or null. */
export function lastJsonBlock(report: string): string | null {
  const blocks = [...report.matchAll(/```json[^\S\n]*\r?\n([\s\S]*?)\r?\n[^\S\n]*```/gi)];
  const last = blocks[blocks.length - 1];
  return last ? last[1]! : null;
}

/** Parse and validate the goals an agent reported. Throws {@link PlanDraftParseError}. */
export function parseDraftGoals(report: string): DraftGoals {
  const raw = lastJsonBlock(report);
  if (raw === null) throw new PlanDraftParseError("the report has no ```json block with goals");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new PlanDraftParseError(
      `the goals block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = DraftGoalsSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
    throw new PlanDraftParseError(`the goals are not valid${where}: ${first?.message ?? "?"}`);
  }
  return parsed.data;
}

/** Fields every goal of the plan shares (the wizard's "About this project"). */
export interface DraftShared {
  stack: string;
  doRules: string[];
  dontRules: string[];
  testRun: string;
}

export const DEFAULT_DRAFT_SHARED: DraftShared = {
  stack: "not specified",
  doRules: ["Follow the conventions of the existing code"],
  dontRules: [],
  testRun: "the project's test command",
};

/**
 * Goal inputs for `replaceGoals`. Ids that clash with `takenIds` get a `-2` style suffix (the
 * dependencies inside the draft follow the rename).
 */
export function buildGoalInputs(
  draft: DraftGoals,
  shared: DraftShared,
  takenIds: Iterable<string> = [],
): GoalInputParsed[] {
  const taken = new Set(takenIds);
  const renamed = new Map<string, string>();
  for (const goal of draft.goals) {
    const id = taken.has(goal.id) ? uniqueKebabId(goal.id, taken) : goal.id;
    taken.add(id);
    renamed.set(goal.id, id);
  }
  return draft.goals.map((goal) => ({
    id: renamed.get(goal.id)!,
    title: goal.title,
    dependsOn: goal.dependsOn.map((dep) => renamed.get(dep) ?? dep),
    spec: {
      goal: goal.details.trim() === "" ? goal.title : `${goal.title}\n\n${goal.details.trim()}`,
      stack: shared.stack,
      rules: { do: shared.doRules, dont: shared.dontRules },
      tests: { strategy: "unit", technology: "project default", run: shared.testRun },
    },
  }));
}

export type PlanDraftApplied =
  { kind: "applied"; goals: number; version: number } | { kind: "stale"; reason: string };

/**
 * Put an agent's reported goals into the plan they were drafted for, but only while that plan is
 * still a draft at the version the drafting started from. Otherwise the plan is left as it is
 * (`stale`). Throws {@link PlanDraftParseError} when the report holds no valid goals.
 */
export async function applyPlanDraft(opts: {
  projectDir: string;
  planId: string;
  planVersion: number;
  report: string;
  shared?: Partial<DraftShared>;
}): Promise<PlanDraftApplied> {
  const draft = parseDraftGoals(opts.report);
  const store = new PlanStore(opts.projectDir);
  const plan = await store.get(opts.planId);
  if (!plan) return { kind: "stale", reason: "the plan no longer exists" };
  if (plan.status !== "draft") return { kind: "stale", reason: `the plan is now ${plan.status}` };
  if (plan.version !== opts.planVersion) {
    return { kind: "stale", reason: "the plan changed while drafting" };
  }
  // The plan's own goals, when it has some, set the shared fields; the rest comes from the caller.
  const first = plan.goals[0]?.spec;
  const shared: DraftShared = {
    ...DEFAULT_DRAFT_SHARED,
    ...(first
      ? {
          stack: first.stack,
          doRules: first.rules.do,
          dontRules: first.rules.dont,
          testRun: first.tests.run,
        }
      : {}),
    ...Object.fromEntries(Object.entries(opts.shared ?? {}).filter(([, v]) => v !== undefined)),
  };
  try {
    const saved = await store.save(
      { ...plan, goals: applyGoalInputs([], buildGoalInputs(draft, shared), { replace: true }) },
      { expectedVersion: opts.planVersion, by: "plan-draft" },
    );
    return { kind: "applied", goals: saved.goals.length, version: saved.version };
  } catch (err) {
    if (err instanceof PlanVersionConflict) {
      return { kind: "stale", reason: "the plan changed while drafting" };
    }
    throw err;
  }
}
