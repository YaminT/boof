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

describe("the assistant's day limit", () => {
  const latestOf = (b?: Record<string, unknown>) => ({ settings: settings(b), project: project() });

  it("has its own field, apart from the other tools", () => {
    const v = budgetsPage.values(
      settings({ perToolDayUsd: { codex: 5, concierge: 1.5 } }),
      project({ perToolDayUsd: { concierge: 0.5 } }),
    );
    expect(v.global.perTool).toBe("codex=5");
    expect(v.global.concierge).toBe("1.5");
    expect(v.project.perTool).toBe("");
    expect(v.project.concierge).toBe("0.5");
  });

  it("writes concierge into perToolDayUsd and keeps the other tools", () => {
    const stored = { perToolDayUsd: { codex: 5 } };
    const base = budgetsPage.values(settings(stored), project());
    const form = { ...base, global: { ...base.global, concierge: "2" } };
    expect(budgetsPage.patches(form, base, latestOf(stored))).toEqual({
      settings: { budget: { perToolDayUsd: { codex: 5, concierge: 2 } } },
    });
  });

  it("clearing it removes the key; editing the list keeps it", () => {
    const stored = { perToolDayUsd: { codex: 5, concierge: 2 } };
    const base = budgetsPage.values(settings(stored), project());
    const cleared = { ...base, global: { ...base.global, concierge: "" } };
    expect(budgetsPage.patches(cleared, base, latestOf(stored)).settings).toEqual({
      budget: { perToolDayUsd: { codex: 5 } },
    });
    const list = { ...base, global: { ...base.global, perTool: "codex=7" } };
    expect(budgetsPage.patches(list, base, latestOf(stored)).settings).toEqual({
      budget: { perToolDayUsd: { codex: 7, concierge: 2 } },
    });
  });

  it("sets the project's own concierge limit", () => {
    const base = budgetsPage.values(settings(), project());
    const form = { ...base, project: { ...base.project, concierge: "1" } };
    expect(
      budgetsPage.patches(form, base, { settings: settings(), project: project() }).project,
    ).toEqual({ budget: { perToolDayUsd: { concierge: 1 } } });
  });

  it("refuses concierge typed into the list and a bad amount", () => {
    const base = budgetsPage.values(settings(), project());
    const typed = { ...base, global: { ...base.global, perTool: "concierge=3" } };
    expect(budgetsPage.problems(typed).join(" ")).toContain("own field");
    const bad = { ...base, global: { ...base.global, concierge: "abc" } };
    expect(budgetsPage.problems(bad).join(" ")).toContain("Console assistant (concierge)");
  });
});
