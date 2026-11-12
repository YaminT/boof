import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanStore } from "./plan-store.js";
import {
  applyPlanDraft,
  buildGoalInputs,
  DEFAULT_DRAFT_SHARED,
  parseDraftGoals,
  PlanDraftParseError,
} from "./plan-draft.js";

const block = (value: unknown) =>
  `Here are the goals.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const good = {
  goals: [
    { id: "setup", title: "Set up", details: "Add the package", dependsOn: [] },
    { id: "feature", title: "Feature", details: "", dependsOn: ["setup"] },
  ],
};

describe("parseDraftGoals", () => {
  it("parses the last json block of the report", () => {
    const report = `${block({ goals: [{ id: "old", title: "Old" }] })}\nThen:\n${block(good)}`;
    expect(parseDraftGoals(report).goals.map((g) => g.id)).toEqual(["setup", "feature"]);
  });

  it("refuses a report without a block and malformed json", () => {
    expect(() => parseDraftGoals("no goals here")).toThrow(PlanDraftParseError);
    expect(() => parseDraftGoals("```json\n{not json\n```")).toThrow(/not valid JSON/);
  });

  it("refuses more than 40 goals, bad ids, long titles and unknown keys", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ id: `g-${i}`, title: "t" }));
    expect(() => parseDraftGoals(block({ goals: many }))).toThrow(PlanDraftParseError);
    expect(() => parseDraftGoals(block({ goals: [{ id: "Bad Id", title: "t" }] }))).toThrow(
      PlanDraftParseError,
    );
    expect(() => parseDraftGoals(block({ goals: [{ id: "a", title: "x".repeat(201) }] }))).toThrow(
      PlanDraftParseError,
    );
    expect(() => parseDraftGoals(block({ goals: [{ id: "a", title: "t", extra: 1 }] }))).toThrow(
      PlanDraftParseError,
    );
    expect(() => parseDraftGoals(block({ goals: [] }))).toThrow(PlanDraftParseError);
  });

  it("refuses duplicate ids and dependencies on later or unknown goals", () => {
    const dup = {
      goals: [
        { id: "a", title: "A" },
        { id: "a", title: "B" },
      ],
    };
    expect(() => parseDraftGoals(block(dup))).toThrow(/duplicate/);
    const later = {
      goals: [
        { id: "a", title: "A", dependsOn: ["b"] },
        { id: "b", title: "B" },
      ],
    };
    expect(() => parseDraftGoals(block(later))).toThrow(/earlier goal/);
    const self = { goals: [{ id: "a", title: "A", dependsOn: ["a"] }] };
    expect(() => parseDraftGoals(block(self))).toThrow(PlanDraftParseError);
  });
});

describe("buildGoalInputs", () => {
  it("carries the shared fields and the details into every goal", () => {
    const inputs = buildGoalInputs(parseDraftGoals(block(good)), {
      stack: "Rust",
      doRules: ["Be brief"],
      dontRules: ["Do not panic"],
      testRun: "cargo test",
    });
    expect(inputs[0]!.spec).toMatchObject({
      goal: "Set up\n\nAdd the package",
      stack: "Rust",
      rules: { do: ["Be brief"], dont: ["Do not panic"] },
      tests: { run: "cargo test" },
    });
    expect(inputs[1]!.spec.goal).toBe("Feature");
    expect(inputs[1]!.dependsOn).toEqual(["setup"]);
  });

  it("suffixes ids that clash with existing goals and follows the rename in dependencies", () => {
    const inputs = buildGoalInputs(parseDraftGoals(block(good)), DEFAULT_DRAFT_SHARED, ["setup"]);
    expect(inputs.map((g) => g.id)).toEqual(["setup-2", "feature"]);
    expect(inputs[1]!.dependsOn).toEqual(["setup-2"]);
  });
});

describe("applyPlanDraft", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-draft-"));
    dirs.push(dir);
    const store = new PlanStore(dir);
    await store.create({ id: "p", title: "P", source: { kind: "ui" } });
    return { dir, store };
  };

  it("replaces the goals of the draft plan it started from", async () => {
    const { dir, store } = await setup();
    const out = await applyPlanDraft({
      projectDir: dir,
      planId: "p",
      planVersion: 1,
      report: block(good),
      shared: { stack: "Go" },
    });
    expect(out).toEqual({ kind: "applied", goals: 2, version: 2 });
    const plan = await store.require("p");
    expect(plan.goals.map((g) => g.id)).toEqual(["setup", "feature"]);
    expect(plan.goals[0]!.spec.stack).toBe("Go");
  });

  it("leaves a plan that changed or is no longer a draft alone", async () => {
    const { dir, store } = await setup();
    const changed = await applyPlanDraft({
      projectDir: dir,
      planId: "p",
      planVersion: 5,
      report: block(good),
    });
    expect(changed).toEqual({ kind: "stale", reason: "the plan changed while drafting" });
    await store.modify("p", (p) => ({ ...p, status: "archived" }));
    const archived = await applyPlanDraft({
      projectDir: dir,
      planId: "p",
      planVersion: 2,
      report: block(good),
    });
    expect(archived.kind).toBe("stale");
    expect((await store.require("p")).goals).toEqual([]);
  });

  it("throws on invalid output and leaves the plan alone", async () => {
    const { dir, store } = await setup();
    await expect(
      applyPlanDraft({ projectDir: dir, planId: "p", planVersion: 1, report: "junk" }),
    ).rejects.toThrow(PlanDraftParseError);
    expect((await store.require("p")).version).toBe(1);
  });
});
