import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { agentsPage, checkedAgo, usageLabel } from "./settings-agents.js";

const roles = {
  planner: { tool: "claude-code", model: "opus" },
  developer: { tool: "codex", model: "gpt" },
  reviewer: { tool: "claude-code", model: "sonnet" },
};
const settings = (over: Record<string, unknown> = {}) =>
  ({
    runner: { enabled: false, concurrency: 1 },
    roles,
    models: { codex: ["gpt"] },
    ...over,
  }) as unknown as Settings;
const project = (over: Record<string, unknown> = {}) =>
  ({ id: "alpha", ...over }) as unknown as Project;

describe("agentsPage values", () => {
  it("fills the schema defaults when keys are absent", () => {
    const v = agentsPage.values(settings(), project());
    expect(v.global).toMatchObject({
      gate: true,
      maxFixRounds: "2",
      transient: "2",
      onDone: "keep-branch",
      onFailure: "keep",
    });
    expect(v.global.models["claude-code"]).toEqual(["opus", "sonnet"]);
    expect(v.project).toEqual({
      roles: {},
      gate: null,
      maxFixRounds: null,
      transient: null,
      onDone: null,
      onFailure: null,
    });
  });
});

describe("agentsPage patches", () => {
  const review = { gate: true, maxFixRounds: 2, maxInlineDiffBytes: 5000 };

  it("a clean form sends nothing", () => {
    const v = agentsPage.values(settings(), project());
    expect(agentsPage.patches(v, v, { settings: settings(), project: project() })).toEqual({});
  });

  it("changing only maxFixRounds keeps the keys the page does not show", () => {
    const s = settings({ review });
    const base = agentsPage.values(s, project());
    const form = { ...base, global: { ...base.global, maxFixRounds: "0" } };
    expect(agentsPage.patches(form, base, { settings: s, project: project() })).toEqual({
      settings: { review: { gate: true, maxFixRounds: 0, maxInlineDiffBytes: 5000 } },
    });
  });

  it("keeps a value another writer changed in the same object", () => {
    const base = agentsPage.values(settings({ review }), project());
    const form = { ...base, global: { ...base.global, gate: false } };
    const latest = settings({ review: { ...review, maxInlineDiffBytes: 9999 } });
    expect(
      agentsPage.patches(form, base, { settings: latest, project: project() }).settings?.review,
    ).toEqual({
      gate: false,
      maxFixRounds: 2,
      maxInlineDiffBytes: 9999,
    });
  });

  it("a project override of gate sits beside the keys the project already has", () => {
    const p = project({ review: { maxInlineDiffBytes: 9 } });
    const base = agentsPage.values(settings(), p);
    const form = { ...base, project: { ...base.project, gate: false } };
    expect(agentsPage.patches(form, base, { settings: settings(), project: p })).toEqual({
      project: { review: { maxInlineDiffBytes: 9, gate: false } },
    });
  });

  it("clearing an override back to inherit drops the key; an empty object becomes null", () => {
    const p = project({ retries: { transient: 1 } });
    const base = agentsPage.values(settings(), p);
    expect(base.project.transient).toBe("1");
    const form = { ...base, project: { ...base.project, transient: null } };
    expect(agentsPage.patches(form, base, { settings: settings(), project: p })).toEqual({
      project: { retries: null },
    });
  });

  it("clearing one role override keeps the others the project has", () => {
    const p = project({ roles: { planner: { tool: "codex", model: "x" } } });
    const base = agentsPage.values(settings(), p);
    const withDev = {
      ...base,
      project: {
        ...base.project,
        roles: { ...base.project.roles, developer: { tool: "codex", model: "y" } },
      },
    };
    const mid = agentsPage.patches(withDev, base, { settings: settings(), project: p });
    expect(mid.project?.roles).toEqual({
      planner: { tool: "codex", model: "x" },
      developer: { tool: "codex", model: "y" },
    });
    const p2 = project({ roles: mid.project!.roles });
    const base2 = agentsPage.values(settings(), p2);
    const cleared = {
      ...base2,
      project: { ...base2.project, roles: { planner: { tool: "codex", model: "x" } } },
    };
    expect(
      agentsPage.patches(cleared, base2, { settings: settings(), project: p2 }).project?.roles,
    ).toEqual({
      planner: { tool: "codex", model: "x" },
    });
  });

  it("zero fix rounds is a real value, not unset", () => {
    const base = agentsPage.values(settings(), project());
    const form = { ...base, project: { ...base.project, maxFixRounds: "0" } };
    expect(agentsPage.patches(form, base, { settings: settings(), project: project() })).toEqual({
      project: { review: { maxFixRounds: 0 } },
    });
  });

  it("adding a model keeps the other tools of the latest server map", () => {
    const s = settings({ models: { codex: ["gpt"], opencode: ["k"] } });
    const base = agentsPage.values(s, project());
    const form = {
      ...base,
      global: { ...base.global, models: { ...base.global.models, codex: ["gpt", "new"] } },
    };
    const latest = settings({ models: { codex: ["gpt"], opencode: ["k", "extra"] } });
    const out = agentsPage.patches(form, base, { settings: latest, project: project() }).settings
      ?.models;
    expect(out).toEqual({ codex: ["gpt", "new"], opencode: ["k", "extra"] });
  });

  it("removing the observer removes it from the saved roles", () => {
    const s = settings({ roles: { ...roles, observer: { tool: "codex", model: "gpt" } } });
    const base = agentsPage.values(s, project());
    const { observer: _o, ...rest } = base.global.roles;
    const form = { ...base, global: { ...base.global, roles: rest } };
    const out = agentsPage.patches(form, base, { settings: s, project: project() }).settings?.roles;
    expect(out && "observer" in out).toBe(false);
    expect(out?.planner).toEqual(roles.planner);
  });
});

describe("agentsPage problems", () => {
  it("explains what stops a save", () => {
    const base = agentsPage.values(settings(), project());
    const bad = {
      global: { ...base.global, concurrency: "0", maxFixRounds: "x", transient: "-1" },
      project: { ...base.project, maxFixRounds: "-1", transient: "q" },
    };
    expect(agentsPage.problems(bad)).toEqual([
      "Run at least 1 task at a time.",
      "Use a whole number of 0 or more for fix rounds.",
      "Use a whole number of 0 or more for retries.",
      "Fix rounds for this project: use a whole number of 0 or more.",
      "Retries for this project: use a whole number of 0 or more.",
    ]);
    expect(agentsPage.problems(base)).toEqual([]);
  });
});

describe("helpers", () => {
  it("checkedAgo", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    expect(checkedAgo("2026-11-02T11:59:30Z", now)).toBe("checked just now");
    expect(checkedAgo("2026-11-02T11:55:00Z", now)).toBe("checked 5 min ago");
    expect(checkedAgo(undefined, now)).toBeNull();
  });
  it("usageLabel", () => {
    expect(usageLabel("planner")).toBe("planner");
    expect(usageLabel("project:alpha:developer")).toBe("alpha: developer");
  });
});
