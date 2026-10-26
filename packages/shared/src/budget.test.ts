import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blockingScopes,
  dailyLedgerPath,
  dayKey,
  evaluateBudget,
  markBudgetNotified,
  nextDayStart,
  readDailyLedger,
  recordSpend,
} from "./budget.js";
import { effectiveSettings, defaultSettings } from "./settings.js";
import { BudgetSettingsSchema, ProjectBudgetOverrideSchema, type Project } from "./schema.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-budget-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const project = (id: string, budget?: Project["budget"]) => ({ id, budget });

describe("day boundaries", () => {
  it("names the day in the configured zone", () => {
    const t = new Date("2026-10-26T23:30:00Z");
    expect(dayKey(t, "UTC")).toBe("2026-10-26");
    expect(dayKey(t, "Asia/Tokyo")).toBe("2026-10-27");
    expect(dayKey(t, "America/Los_Angeles")).toBe("2026-10-26");
  });

  it("finds the next midnight, across a DST change", () => {
    expect(nextDayStart(new Date("2026-10-26T23:30:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-10-27T15:00:00.000Z",
    );
    // Berlin ends DST on 2026-10-25: that day has 25 hours.
    expect(nextDayStart(new Date("2026-10-25T10:00:00Z"), "Europe/Berlin").toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
  });

  it("rolls the ledger over at local midnight", async () => {
    const base = { dataRoot: root, projectId: "p", tool: "mock", timezone: "Asia/Tokyo" };
    const usage = { costUsd: 1, known: true };
    await recordSpend({ ...base, usage, now: new Date("2026-10-26T14:59:00Z") }); // 23:59 JST
    await recordSpend({ ...base, usage, now: new Date("2026-10-26T15:01:00Z") }); // 00:01 JST
    expect((await readDailyLedger(root, "2026-10-26", "Asia/Tokyo")).costUsd).toBe(1);
    expect((await readDailyLedger(root, "2026-10-27", "Asia/Tokyo")).costUsd).toBe(1);
    const file = JSON.parse(await readFile(dailyLedgerPath(root, "2026-10-27"), "utf8"));
    expect(file).toMatchObject({ timezone: "Asia/Tokyo", tools: { mock: 1 }, projects: { p: 1 } });
  });
});

describe("ledger", () => {
  it("counts unknown usage as zero and flags it", async () => {
    const base = { dataRoot: root, projectId: "p", tool: "codex", timezone: "UTC" };
    const now = new Date("2026-10-26T12:00:00Z");
    await recordSpend({ ...base, usage: { costUsd: 0.5, known: true }, now });
    await recordSpend({ ...base, usage: { costUsd: 9, known: false }, now });
    const day = await readDailyLedger(root, "2026-10-26", "UTC");
    expect(day).toMatchObject({ costUsd: 0.5, unknownSteps: 1, tools: { codex: 0.5 } });
  });

  it("announces a scope once per day", async () => {
    expect(await markBudgetNotified(root, "2026-10-26", "UTC", "global")).toBe(true);
    expect(await markBudgetNotified(root, "2026-10-26", "UTC", "global")).toBe(false);
    expect(await markBudgetNotified(root, "2026-10-27", "UTC", "global")).toBe(true);
  });
});

describe("evaluation", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const spend = (projectId: string, tool: string, costUsd: number) =>
    recordSpend({
      dataRoot: root,
      projectId,
      tool,
      usage: { costUsd, known: true },
      timezone: "UTC",
      now,
    });

  it("reports unlimited scopes as never exceeded", async () => {
    await spend("a", "mock", 100);
    const s = await evaluateBudget(
      root,
      { budget: { onExceed: "pause", timezone: "UTC" } },
      [project("a")],
      now,
    );
    expect(s.exceeded).toEqual([]);
    expect(s.scopes[0]).toMatchObject({ scope: "global", spentUsd: 100, limitUsd: null });
    expect(s.resetsAt).toBe("2026-10-27T00:00:00.000Z");
  });

  it("flags global, project and tool scopes and what each blocks", async () => {
    await spend("a", "codex", 2);
    await spend("b", "mock", 1);
    const settings = {
      budget: {
        onExceed: "pause" as const,
        timezone: "UTC",
        perDayUsd: 10,
        perProjectDayUsd: 2,
        perToolDayUsd: { codex: 2, mock: 5 },
      },
    };
    const s = await evaluateBudget(root, settings, [project("a"), project("b")], now);
    expect(s.exceeded.map((e) => e.scope)).toEqual(["tool:codex", "project:a"]);
    expect(blockingScopes(s, "a", ["mock"]).map((e) => e.scope)).toEqual(["project:a"]);
    expect(blockingScopes(s, "b", ["codex"]).map((e) => e.scope)).toEqual(["tool:codex"]);
    expect(blockingScopes(s, "b", ["mock"])).toEqual([]);
  });

  it("lets a project override its day limit and cap its own tool spend", async () => {
    await spend("a", "mock", 3);
    const settings = {
      budget: { onExceed: "pause" as const, timezone: "UTC", perProjectDayUsd: 2 },
    };
    const roomy = project("a", { perProjectDayUsd: 50, perToolDayUsd: { mock: 3 } });
    const s = await evaluateBudget(root, settings, [roomy], now);
    expect(s.exceeded.map((e) => e.scope)).toEqual(["project:a/tool:mock"]);
    expect(s.scopes.find((x) => x.scope === "project:a")?.remainingUsd).toBe(47);
  });
});

describe("schema", () => {
  it("defaults onExceed to pause and rejects bad zones and limits", () => {
    expect(BudgetSettingsSchema.parse({}).onExceed).toBe("pause");
    expect(BudgetSettingsSchema.safeParse({ timezone: "Mars/Base" }).success).toBe(false);
    expect(BudgetSettingsSchema.safeParse({ perTaskUsd: -1 }).success).toBe(false);
    expect(ProjectBudgetOverrideSchema.safeParse({ perDayUsd: 1 }).success).toBe(false);
  });

  it("merges a project override over the global budget", () => {
    const global = {
      ...defaultSettings(),
      budget: BudgetSettingsSchema.parse({ perTaskUsd: 1, perDayUsd: 9, onExceed: "fail" }),
    };
    const eff = effectiveSettings(global, {
      budget: { perTaskUsd: 5 },
      workingDirectory: "/x",
    } as Project);
    expect(eff.budget).toMatchObject({ perTaskUsd: 5, perDayUsd: 9, onExceed: "fail" });
  });
});
