import { describe, expect, it } from "vitest";
import {
  appendVersion,
  currentStatus,
  goalErrors,
  nextGoal,
  parseGoal,
  parsePlan,
  serializeGoal,
  serializePlan,
  topoSort,
  type BoofGoal,
  type PlanGoal,
} from "./boof-goal.js";

const SAMPLE_GOAL = `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <model>claude-opus-4-8</model>
  <overal>
    <goal>Build the core module.</goal>
    <stack>TypeScript, vitest.</stack>
    <rules>
      <do>Write a failing test first.</do>
      <do>Keep it small.</do>
      <dont>Do not add network calls.</dont>
    </rules>
  </overal>
  <progress>
    <status>
      <versions>
        <version number="1" status="plan">Initial seeding.</version>
        <version number="2" status="develop">Requested changes.</version>
      </versions>
    </status>
    <tests>
      <strategy>TDD: red then green.</strategy>
      <technology>vitest</technology>
      <run>npm test</run>
      <coverage>80% lines</coverage>
    </tests>
  </progress>
</boof>`;

describe("goal.boof.xml", () => {
  it("parses all fields including optional model and coverage", () => {
    const g = parseGoal(SAMPLE_GOAL);
    expect(g.model).toBe("claude-opus-4-8");
    expect(g.overal.goal).toBe("Build the core module.");
    expect(g.overal.stack).toBe("TypeScript, vitest.");
    expect(g.overal.rules.do).toEqual(["Write a failing test first.", "Keep it small."]);
    expect(g.overal.rules.dont).toEqual(["Do not add network calls."]);
    expect(g.progress.versions).toHaveLength(2);
    expect(g.progress.tests.technology).toBe("vitest");
    expect(g.progress.tests.coverage).toBe("80% lines");
  });

  it("current status is the highest version number's status", () => {
    expect(currentStatus(parseGoal(SAMPLE_GOAL))).toBe("develop");
  });

  it("round-trips through serialize → parse", () => {
    const g = parseGoal(SAMPLE_GOAL);
    const again = parseGoal(serializeGoal(g));
    expect(again).toEqual(g);
  });

  it("appendVersion bumps the current status by adding the next version number", () => {
    const g = parseGoal(SAMPLE_GOAL);
    const bumped = appendVersion(g, "done", "Implemented by boof-runner.");
    expect(currentStatus(bumped)).toBe("done");
    const last = bumped.progress.versions[bumped.progress.versions.length - 1];
    expect(last.number).toBe(3);
    expect(last.status).toBe("done");
    // Original is not mutated.
    expect(currentStatus(g)).toBe("develop");
    // Survives a round-trip.
    expect(currentStatus(parseGoal(serializeGoal(bumped)))).toBe("done");
  });

  it("reports validation errors for a malformed goal file", () => {
    expect(goalErrors("<boof></boof>").length).toBeGreaterThan(0);
    expect(goalErrors(SAMPLE_GOAL)).toEqual([]);
  });
});

describe("plan.boof.xml", () => {
  const PLAN = `<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goals>
    <goal id="web" path="apps/web" order="2" status="plan">
      <depends-on>core</depends-on>
    </goal>
    <goal id="core" path="packages/core" order="1" status="done"></goal>
  </goals>
</plan>`;

  it("parses goals sorted by order with dependencies", () => {
    const p = parsePlan(PLAN);
    expect(p.goals.map((g) => g.id)).toEqual(["core", "web"]);
    expect(p.goals[1].dependsOn).toEqual(["core"]);
  });

  it("round-trips through serialize → parse", () => {
    const p = parsePlan(PLAN);
    expect(parsePlan(serializePlan(p))).toEqual(p);
  });
});

describe("ordering / next-goal semantics", () => {
  const goals: PlanGoal[] = [
    { id: "core", path: "core", order: 1, status: "plan", dependsOn: [] },
    { id: "web", path: "web", order: 2, status: "plan", dependsOn: ["core"] },
    { id: "api", path: "api", order: 3, status: "plan", dependsOn: ["core"] },
  ];

  it("topoSort is deterministic and dependency-consistent", () => {
    expect(topoSort(goals)).toEqual(["core", "api", "web"]);
  });

  it("nextGoal picks the lowest-order not-done goal whose deps are done", () => {
    // core not done → it is next (no deps).
    expect(nextGoal(goals)?.id).toBe("core");
    // core done → web (order 2) becomes actionable before api.
    const statuses = new Map([["core", "done" as const]]);
    expect(nextGoal(goals, statuses)?.id).toBe("web");
  });

  it("nextGoal returns null when everything is done", () => {
    const done = new Map(goals.map((g) => [g.id, "done" as const]));
    expect(nextGoal(goals, done)).toBeNull();
  });
});
