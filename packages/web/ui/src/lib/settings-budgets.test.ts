import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@boof/heart/schema";
import { budgetsPage } from "./settings-budgets.js";

const settings = (budget?: Record<string, unknown>) => ({ budget }) as unknown as Settings;
const project = (budget?: Record<string, unknown>) =>
  ({ id: "alpha", budget }) as unknown as Project;

describe("budgetsPage", () => {
  it("a clean form sends nothing", () => {
    const v = budgetsPage.values(settings({ perDayUsd: 5 }), project());
    expect(
      budgetsPage.patches(v, v, { settings: settings({ perDayUsd: 5 }), project: project() }),
    ).toEqual({});
  });

  it("changing only perTask keeps a limit another writer set meanwhile", () => {
    const base = budgetsPage.values(settings({ onExceed: "pause" }), project());
    const form = { ...base, global: { ...base.global, perTask: "3" } };
    const latest = settings({ perDayUsd: 25, onExceed: "pause" });
    expect(budgetsPage.patches(form, base, { settings: latest, project: project() })).toEqual({
      settings: { budget: { perDayUsd: 25, onExceed: "pause", perTaskUsd: 3 } },
    });
  });

  it("clearing the project's only key makes its budget null", () => {
    const p = project({ perTaskUsd: 2 });
    const base = budgetsPage.values(settings(), p);
    const form = { ...base, project: { ...base.project, perTask: "" } };
    expect(budgetsPage.patches(form, base, { settings: settings(), project: p })).toEqual({
      project: { budget: null },
    });
  });

  it("a project onExceed back to inherit removes the key even when the server holds one", () => {
    const base = budgetsPage.values(settings(), project());
    const form = { ...base, project: { ...base.project, onExceed: "" as const } };
    const latest = project({ onExceed: "fail", perTaskUsd: 1 });
    expect(budgetsPage.patches(form, base, { settings: settings(), project: latest })).toEqual({});
    const base2 = budgetsPage.values(settings(), latest);
    const form2 = { ...base2, project: { ...base2.project, onExceed: "" as const } };
    expect(budgetsPage.patches(form2, base2, { settings: settings(), project: latest })).toEqual({
      project: { budget: { perTaskUsd: 1 } },
    });
  });

  it("the project's day limit is its perProjectDayUsd", () => {
    const base = budgetsPage.values(settings(), project());
    const form = { ...base, project: { ...base.project, perDay: "4.5" } };
    expect(budgetsPage.patches(form, base, { settings: settings(), project: project() })).toEqual({
      project: { budget: { perProjectDayUsd: 4.5 } },
    });
  });

  it("per-tool limits are parsed", () => {
    const base = budgetsPage.values(settings(), project());
    const form = { ...base, project: { ...base.project, perTool: "codex=5\nopencode=1" } };
    expect(
      budgetsPage.patches(form, base, { settings: settings(), project: project() }).project?.budget,
    ).toEqual({
      perToolDayUsd: { codex: 5, opencode: 1 },
    });
  });

  it("explains each bad field", () => {
    const base = budgetsPage.values(settings(), project());
    const bad = {
      global: {
        ...base.global,
        perTask: "0",
        perDay: "0",
        perProjectDay: "x",
        perTool: "codex",
        timezone: "Mars/Base",
      },
      project: { ...base.project, perTask: "-1", perDay: "0", perTool: "x" },
    };
    expect(budgetsPage.problems(bad)).toEqual([
      "Per task: use an amount in USD above 0, or leave it empty for no limit.",
      "Per day, all work: use an amount in USD above 0, or leave it empty for no limit.",
      "Per day, each project: use an amount in USD above 0, or leave it empty for no limit.",
      "Per day, each tool: write one tool=USD per line, for example codex=5.",
      "Time zone: use an IANA name such as Europe/Berlin.",
      "This project, per task: use an amount in USD above 0, or leave it empty for no limit.",
      "This project, per day: use an amount in USD above 0, or leave it empty for no limit.",
      "This project, Per day, each tool: write one tool=USD per line, for example codex=5.",
    ]);
    expect(budgetsPage.problems(base)).toEqual([]);
  });
});
