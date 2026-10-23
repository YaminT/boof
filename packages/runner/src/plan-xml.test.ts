import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportPlanXml,
  goalFilePath,
  GOAL_FILE,
  PLAN_FILE,
  PlanSchema,
  parseGoal,
  serializeGoal,
  serializePlan,
  validatePlan,
  type BoofGoal,
  type Plan,
} from "@boof-runner/shared";
import { buildUnitPrompt, scanRepo } from "./boof-scan.js";
import { goalsFromScan, mergeImportedGoals } from "./plan-import.js";
import { buildGoalPrompt } from "./plan-sync.js";

let repo: string;

function goal(
  text: string,
  status: "plan" | "develop" | "review" | "done",
  extra: Partial<BoofGoal> = {},
): BoofGoal {
  return {
    overal: {
      goal: text,
      stack: "TypeScript",
      rules: { do: ["Write a failing test first."], dont: ["Touch other units."] },
    },
    progress: {
      versions: [
        { number: 1, status: "plan", description: "seed" },
        ...(status === "plan"
          ? []
          : [{ number: 3, status, description: "moved on <carefully> & fast" }]),
      ],
      tests: { strategy: "TDD", technology: "vitest", run: "npm test", coverage: "80%" },
    },
    ...extra,
  };
}

async function writeUnit(dir: string, g: BoofGoal): Promise<void> {
  await mkdir(join(repo, dir), { recursive: true });
  await writeFile(join(repo, dir, GOAL_FILE), serializeGoal(g), "utf8");
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boof-planxml-"));
  await writeUnit("core", goal("Core", "done", { model: "opus" }));
  await writeUnit("packages/web", goal("Web", "develop"));
  await writeUnit("api", goal("Api", "plan"));
  await writeFile(
    join(repo, PLAN_FILE),
    serializePlan({
      goals: [
        { id: "core", path: "core", order: 1, status: "done", dependsOn: [] },
        { id: "api", path: "api", order: 2, status: "plan", dependsOn: ["core"] },
        {
          id: "web",
          path: "packages/web",
          order: 3,
          status: "develop",
          dependsOn: ["core", "api"],
        },
      ],
    }),
    "utf8",
  );
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function importPlan(): Plan {
  const { goals } = goalsFromScan(scanRepoSync());
  return validatePlan(
    PlanSchema.parse({
      id: "repo",
      title: "Repo",
      source: { kind: "repo-import" },
      goals,
      created: "2026-06-04T10:00:00.000Z",
      updated: "2026-06-04T10:00:00.000Z",
    }),
    { normalizeOrder: true },
  );
}
let scanned: Awaited<ReturnType<typeof scanRepo>>;
const scanRepoSync = () => scanned;

describe("import then export", () => {
  beforeEach(async () => {
    scanned = await scanRepo(repo);
  });

  it("imports goals with path, order, deps, status, spec and history", () => {
    const plan = importPlan();
    expect(plan.goals.map((g) => [g.id, g.order, g.status, g.path, g.dependsOn])).toEqual([
      ["core", 1, "done", "core", []],
      ["api", 2, "plan", "api", ["core"]],
      ["web", 3, "develop", "packages/web", ["core", "api"]],
    ]);
    const core = plan.goals[0]!;
    expect(core.model).toBe("opus");
    expect(core.spec.rules).toEqual({
      do: ["Write a failing test first."],
      dont: ["Touch other units."],
    });
    expect(core.spec.tests.coverage).toBe("80%");
    expect(core.history.map((h) => [h.number, h.status])).toEqual([
      [1, "plan"],
      [3, "done"],
    ]);
    expect(core.revision).toBe(1);
  });

  it("exports byte-equal XML for untouched goals and for the plan file", async () => {
    const files = exportPlanXml(importPlan());
    expect(Object.keys(files).sort()).toEqual(
      [PLAN_FILE, "api/goal.boof.xml", "core/goal.boof.xml", "packages/web/goal.boof.xml"].sort(),
    );
    for (const [name, content] of Object.entries(files)) {
      expect(content, name).toBe(await readFile(join(repo, name), "utf8"));
    }
  });

  it("export reflects a status change and a new history entry", async () => {
    const plan = importPlan();
    const web = plan.goals.find((g) => g.id === "web")!;
    web.status = "done";
    web.history.push({
      revision: 1,
      status: "done",
      description: "boof-runner completed task x",
      at: "2026-06-05T00:00:00.000Z",
    });
    const files = exportPlanXml(plan);
    const exported = parseGoal(files[goalFilePath(web)]!);
    expect(exported.progress.versions.map((v) => [v.number, v.status])).toEqual([
      [1, "plan"],
      [3, "develop"],
      [4, "done"],
    ]);
  });

  it("an API-born goal without a path exports under its id", () => {
    const plan = importPlan();
    const { path: _p, ...bare } = plan.goals[0]!;
    const files = exportPlanXml({ goals: [{ ...bare, id: "fresh", history: [] }] });
    expect(Object.keys(files).sort()).toEqual([PLAN_FILE, "fresh/goal.boof.xml"].sort());
    expect(parseGoal(files["fresh/goal.boof.xml"]!).progress.versions).toHaveLength(1);
    expect(dirname(goalFilePath({ id: "x", path: "." }))).toBe(".");
  });
});

describe("goalsFromScan ids", () => {
  it("kebab-cases unit dirs without a plan file and reports it", async () => {
    await rm(join(repo, PLAN_FILE));
    const { goals, warnings } = goalsFromScan(await scanRepo(repo));
    const web = goals.find((g) => g.path === "packages/web")!;
    expect(web.id).toBe("packagesweb");
    expect(web.title).toBe("packages/web");
    expect(warnings.some((w) => w.includes("packages/web"))).toBe(true);
  });
});

describe("mergeImportedGoals", () => {
  it("keeps unchanged goals, bumps the revision on a spec change and adopts a further-along status", async () => {
    const stored = importPlan().goals;
    await writeUnit("api", goal("Api v2", "review"));
    const fresh = goalsFromScan(await scanRepo(repo)).goals;
    const merged = mergeImportedGoals(stored, fresh);
    expect(merged.unchanged.sort()).toEqual(["core", "web"]);
    expect(merged.updated).toEqual(["api"]);
    expect(merged.added).toEqual([]);
    const api = merged.goals.find((g) => g.id === "api")!;
    expect(api.revision).toBe(2);
    expect(api.spec.goal).toBe("Api v2");
    expect(api.status).toBe("review");
    expect(api.history.at(-1)!.description).toContain("repository");
  });

  it("does not move a finished goal back when the repo was not written back", async () => {
    const stored = importPlan().goals.map((g) =>
      g.id === "api" ? { ...g, status: "done" as const } : g,
    );
    const merged = mergeImportedGoals(stored, goalsFromScan(await scanRepo(repo)).goals);
    expect(merged.goals.find((g) => g.id === "api")!.status).toBe("done");
    expect(merged.goals.find((g) => g.id === "api")!.revision).toBe(1);
  });

  it("adds new units and keeps goals that left the repo", async () => {
    const stored = importPlan().goals;
    await writeUnit("docs", goal("Docs", "plan"));
    await rm(join(repo, "api"), { recursive: true });
    const merged = mergeImportedGoals(stored, goalsFromScan(await scanRepo(repo)).goals);
    expect(merged.added).toEqual(["docs"]);
    expect(merged.goals.map((g) => g.id).sort()).toEqual(["api", "core", "docs", "web"]);
  });
});

describe("buildGoalPrompt", () => {
  it("equals buildUnitPrompt apart from the trailing Plan section", async () => {
    const scan = await scanRepo(repo);
    const { goals } = goalsFromScan(scan);
    for (const unit of scan.units) {
      const g = goals.find((x) => x.path === unit.dir)!;
      const prompt = buildGoalPrompt(g, "repo", repo);
      const marker = "\n\n## Plan\n";
      const cut = prompt.indexOf(marker);
      expect(prompt.slice(0, cut)).toBe(buildUnitPrompt(unit, repo));
      expect(prompt.slice(cut)).toContain(`- Goal: ${g.id}`);
      expect(prompt.slice(cut)).toContain("- Plan: repo");
    }
  });

  it("omits the goal-file lines for a goal without a path", () => {
    const g = { ...importPlan().goals[0]! };
    delete g.path;
    const prompt = buildGoalPrompt(g, "p", repo);
    expect(prompt).not.toContain("Goal file:");
    expect(prompt).toContain("Current status: done");
  });
});
