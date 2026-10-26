import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  exportPlanXml,
  InvalidIdError,
  PlanExistsError,
  PlanNotFoundError,
  PlanStore,
  PlanValidationError,
  PlanVersionConflict,
  projectPaths,
  SettingsStore,
  type Plan,
} from "@boof-runner/shared";
import {
  importFromRepo,
  mergeImportedGoals,
  PlanNotActiveError,
  syncPlan,
  taskStatusForPlan,
  type SyncResult,
} from "@boof-runner/runner";
import { ProjectResolutionError, resolveProject } from "./headless.js";
import { scaffoldDataRoot } from "./scaffold.js";

export const PLAN_HELP = `boof-runner plan — import, sync and export a project's plans

Usage:
  boof-runner plan import --project <id> [--plan <id>] [-d <data>]
  boof-runner plan sync   --project <id> --plan <id> [--dry-run] [--stop-running] [-d <data>]
  boof-runner plan export --project <id> --plan <id> --out <dir> [-d <data>]

import  Read the project's goal.boof.xml / plan.boof.xml files into a plan (default id: repo).
        An existing plan is merged: goals match by path, changed specs bump their revision.
sync    Turn the active plan's goals into tasks and bring existing tasks in line with changed goals.
        --dry-run only reports; --stop-running also stops running tasks of removed goals.
export  Write plan.boof.xml and every <path>/goal.boof.xml of the plan under --out. Nothing is
        written into the repository itself.`;

const DEFAULT_PLAN = "repo";

function describeSync(res: SyncResult, out: (line: string) => void): void {
  const prefix = res.dryRun ? "(dry run) would " : "";
  for (const c of res.created) {
    out(
      `${prefix}create ${c.taskId}  goal ${c.goalId} r${c.revision}${c.followUp ? " follow-up" : ""}${c.skip ? " (blocked)" : ""}`,
    );
  }
  for (const u of res.updated)
    out(`${prefix}${u.action} ${u.taskId}  goal ${u.goalId} r${u.revision}`);
  for (const a of res.archived) out(`${prefix}${a.action} ${a.taskId}  goal ${a.goalId} removed`);
  for (const s of res.skipped) out(`blocked  goal ${s.goalId}${s.taskId ? ` (${s.taskId})` : ""}`);
  out(
    `${res.created.length} created, ${res.updated.length} updated, ${res.archived.length} archived, ${res.skipped.length} blocked`,
  );
}

/** `plan` subcommand. Returns a process exit code. */
export async function planCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(PLAN_HELP);
    return sub ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        data: { type: "string", short: "d" },
        project: { type: "string" },
        plan: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
        "stop-running": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`plan: ${(e as Error).message}\n`);
    err(PLAN_HELP);
    return 1;
  }
  const { values } = parsed;
  if (values.help) {
    out(PLAN_HELP);
    return 0;
  }
  const root = values.data
    ? isAbsolute(values.data)
      ? values.data
      : resolve(process.cwd(), values.data)
    : defaultRoot();
  if (!["import", "sync", "export"].includes(sub)) {
    err(`plan: unknown subcommand "${sub}"\n`);
    err(PLAN_HELP);
    return 1;
  }
  if ((sub === "sync" || sub === "export") && !values.plan) {
    err(`plan ${sub}: --plan <id> is required`);
    return 1;
  }
  if (sub === "export" && !values.out) {
    err("plan export: --out <dir> is required");
    return 1;
  }

  try {
    await scaffoldDataRoot(root);
    const project = await resolveProject(
      root,
      values.project ? { project: values.project } : {},
      (c) => out(c.replace(/\n$/, "")),
    );
    const projectDir = projectPaths(root, project.id).dir;
    const store = new PlanStore(projectDir);

    if (sub === "import") {
      const planId = values.plan ?? DEFAULT_PLAN;
      const imported = await importFromRepo(project.workingDirectory);
      if (imported.goals.length === 0) {
        err(`plan import: no goal.boof.xml files found under ${project.workingDirectory}`);
        return 1;
      }
      for (const w of imported.warnings) err(`warning: ${w}`);
      const existing = await store.get(planId);
      let plan: Plan;
      let summary: { added: string[]; updated: string[]; unchanged: string[] };
      if (!existing) {
        plan = await store.create({
          id: planId,
          title: `Imported from ${project.name}`,
          status: "active",
          source: { kind: "repo-import", importedFrom: project.workingDirectory },
          goals: imported.goals,
        });
        summary = { added: plan.goals.map((g) => g.id), updated: [], unchanged: [] };
      } else {
        const merged = mergeImportedGoals(existing.goals, imported.goals);
        summary = merged;
        plan = await store.modify(planId, (p) => ({ ...p, goals: merged.goals }));
      }
      out(
        `Plan '${plan.id}' in project '${project.id}' (version ${plan.version}): ${summary.added.length} added, ${summary.updated.length} updated, ${summary.unchanged.length} unchanged`,
      );
      return 0;
    }

    const plan = await store.require(values.plan!);
    if (sub === "sync") {
      const settings = await new SettingsStore(root).load();
      const res = await syncPlan({
        projectDir,
        project,
        planId: plan.id,
        dryRun: values["dry-run"],
        stopRunning: values["stop-running"],
        createStatus: await taskStatusForPlan(root, plan, settings),
      });
      describeSync(res, out);
      return 0;
    }

    // export
    const outDir = resolve(process.cwd(), values.out!);
    const files = exportPlanXml(plan);
    for (const [name, content] of Object.entries(files)) {
      const target = resolve(outDir, name);
      const rel = relative(outDir, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        err(`plan export: refusing to write outside ${outDir}: ${name}`);
        return 1;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    out(`Exported ${Object.keys(files).length} file(s) of plan '${plan.id}' to ${outDir}`);
    return 0;
  } catch (e) {
    if (
      e instanceof ProjectResolutionError ||
      e instanceof PlanNotFoundError ||
      e instanceof PlanNotActiveError ||
      e instanceof PlanVersionConflict ||
      e instanceof PlanExistsError ||
      e instanceof PlanValidationError ||
      e instanceof InvalidIdError
    ) {
      err(`plan ${sub}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
