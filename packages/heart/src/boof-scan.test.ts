import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUnitPrompt, scanRepo, selectActionableUnits } from "./boof-scan.js";

let repo: string;

function goalXml(goal: string, status: "plan" | "develop" | "review" | "done"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>${goal}</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="${status}">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;
}

async function writeGoal(dir: string, goal: string, status: any): Promise<void> {
  await mkdir(join(repo, dir), { recursive: true });
  await writeFile(join(repo, dir, "goal.boof.xml"), goalXml(goal, status), "utf8");
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boof-scan-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("scanRepo", () => {
  it("finds goal files and reports their current status, skipping node_modules", async () => {
    await writeGoal("packages/core", "Core", "done");
    await writeGoal("apps/web", "Web", "develop");
    // Should be ignored:
    await writeGoal("node_modules/pkg", "Dep", "plan");
    await writeGoal(".git/x", "Git", "plan");

    const { units } = await scanRepo(repo);
    const byPath = Object.fromEntries(units.map((u) => [u.dir, u.status]));
    expect(byPath).toEqual({ "packages/core": "done", "apps/web": "develop" });
  });

  it("uses plan.boof.xml order and dependencies when present", async () => {
    await writeGoal("core", "Core", "plan");
    await writeGoal("web", "Web", "plan");
    await writeFile(
      join(repo, "plan.boof.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plan><goals>
  <goal id="web" path="web" order="2" status="plan"><depends-on>core</depends-on></goal>
  <goal id="core" path="core" order="1" status="plan"></goal>
</goals></plan>`,
      "utf8",
    );
    const { units } = await scanRepo(repo);
    // Ordered by plan order (core before web).
    expect(units.map((u) => u.id)).toEqual(["core", "web"]);
    const web = units.find((u) => u.id === "web")!;
    expect(web.dependsOn).toEqual(["core"]);
    // web is blocked because core is not done yet.
    expect(web.blocked).toBe(true);
    expect(units.find((u) => u.id === "core")!.blocked).toBe(false);
  });
});

describe("selectActionableUnits", () => {
  it("returns one entry per not-done unit, deps-first, blocked units last", async () => {
    await writeGoal("core", "Core", "done");
    await writeGoal("web", "Web", "plan");
    await writeGoal("api", "Api", "review");
    await writeFile(
      join(repo, "plan.boof.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plan><goals>
  <goal id="core" path="core" order="1" status="done"></goal>
  <goal id="api" path="api" order="2" status="plan"></goal>
  <goal id="web" path="web" order="3" status="plan"><depends-on>api</depends-on></goal>
</goals></plan>`,
      "utf8",
    );
    const units = await selectActionableUnits(repo);
    // core is done → excluded. api (deps done) before web (blocked by api).
    expect(units.map((u) => u.id)).toEqual(["api", "web"]);
    expect(units.find((u) => u.id === "api")!.blocked).toBe(false);
    expect(units.find((u) => u.id === "web")!.blocked).toBe(true);
  });

  it("with no plan file, includes all not-done units in a deterministic order", async () => {
    await writeGoal("b", "B", "done");
    await writeGoal("a", "A", "plan");
    await writeGoal("c", "C", "develop");
    const units = await selectActionableUnits(repo);
    expect(units.map((u) => u.dir)).toEqual(["a", "c"]);
  });
});

describe("buildUnitPrompt", () => {
  it("embeds the goal, stack, rules, test strategy and forbids editing the goal file", async () => {
    await writeGoal("core", "Build the core.", "plan");
    const units = await selectActionableUnits(repo);
    const prompt = buildUnitPrompt(units[0], repo);
    expect(prompt).toContain("Build the core.");
    expect(prompt).toContain("Write a failing test first.");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain(join(repo, "core", "goal.boof.xml"));
    expect(prompt.toLowerCase()).toContain("do not edit");
  });
});
