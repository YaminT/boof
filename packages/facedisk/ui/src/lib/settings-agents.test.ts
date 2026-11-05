import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@boof/heart/schema";
import {
  agentsPage,
  checkedAgo,
  makeAgentsPage,
  needsAuthNote,
  roleToolNote,
  toolOptionLabel,
  roleModelLabel,
  roleModelOptions,
  roleToolAssignment,
  usageLabel,
} from "./settings-agents.js";

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

  it("renders and saves the Codex CLI default model choice", () => {
    expect(roleModelLabel("codex", "")).toBe("Codex default (from the codex CLI)");
    const s = settings({ roles: { ...roles, developer: { tool: "codex", model: "gpt" } } });
    const base = agentsPage.values(s, project());
    const form = {
      ...base,
      global: {
        ...base.global,
        roles: { ...base.global.roles, developer: { tool: "codex", model: "" } },
      },
    };
    expect(
      agentsPage.patches(form, base, { settings: s, project: project() }).settings?.roles
        ?.developer,
    ).toEqual({ tool: "codex", model: "" });
  });

  it("offers Codex default for a saved model and saves the empty selection", () => {
    const s = settings({ roles: { ...roles, developer: { tool: "codex", model: "gpt-5.5" } } });
    const options = roleModelOptions("codex", { codex: ["gpt-5.5"] }, "gpt-5.5");
    expect(options[0]).toBe("");
    expect(roleModelLabel("codex", options[0]!)).toBe("Codex default (from the codex CLI)");
    const base = agentsPage.values(s, project());
    const form = {
      ...base,
      global: {
        ...base.global,
        roles: { ...base.global.roles, developer: { tool: "codex", model: options[0]! } },
      },
    };
    expect(
      agentsPage.patches(form, base, { settings: s, project: project() }).settings?.roles
        ?.developer,
    ).toEqual({ tool: "codex", model: "" });
  });

  it("switches an empty Codex role to a valid Claude model and back to Codex default", () => {
    const models = { codex: ["gpt-5.5"], "claude-code": ["opus", "sonnet"] };
    const claude = roleToolAssignment("claude-code", models);
    expect(claude).toEqual({ tool: "claude-code", model: "opus" });
    expect(roleToolAssignment("codex", models)).toEqual({ tool: "codex", model: "" });
    expect(roleModelOptions("codex", models, "gpt-5.5")).toContain("");
  });

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

describe("claude-agent in the role editor", () => {
  const agentRoles = { ...roles, developer: { tool: "claude-agent", model: "default" } };

  it("needs the authentication note for claude-agent only", () => {
    expect(needsAuthNote("claude-agent")).toBe(true);
    expect(needsAuthNote("claude-code")).toBe(false);
    expect(needsAuthNote("codex")).toBe(false);
  });

  it("gives claude-agent the default model when the list has not loaded", () => {
    expect(roleToolAssignment("claude-agent", {})).toEqual({
      tool: "claude-agent",
      model: "default",
    });
  });

  it("says why a role cannot use claude-agent on the desktop app", () => {
    expect(roleToolNote("claude-agent", {})?.kind).toBe("auth");
    expect(roleToolNote("claude-agent", { isDesktop: true })).toMatchObject({
      kind: "unavailable",
      text: expect.stringContaining("Not available in the desktop app."),
    });
    expect(roleToolNote("claude-code", { isDesktop: true })).toBeNull();
    expect(toolOptionLabel("claude-agent", { isDesktop: true })).toBe("claude-agent (unavailable)");
    expect(toolOptionLabel("claude-agent", { unavailable: { "claude-agent": "no SDK" } })).toBe(
      "claude-agent (unavailable)",
    );
    expect(toolOptionLabel("claude-agent", {})).toBe("claude-agent");
  });

  it("blocks Save with a page problem for a role on claude-agent in the desktop app", () => {
    const desktop = makeAgentsPage({ isDesktop: true });
    const v = desktop.values(settings({ roles: agentRoles }), project());
    expect(desktop.problems(v)).toEqual(["claude-agent is not available in the desktop app."]);
    const own = desktop.values(settings(), project({ roles: { reviewer: agentRoles.developer } }));
    expect(desktop.problems(own)).toEqual(["claude-agent is not available in the desktop app."]);
    // Elsewhere the same roles are fine.
    expect(
      agentsPage.problems(agentsPage.values(settings({ roles: agentRoles }), project())),
    ).toEqual([]);
    // A tool whose listing carries unavailableReason blocks the same way.
    const server = makeAgentsPage({ unavailable: { "claude-agent": "no SDK" } });
    expect(server.problems(server.values(settings({ roles: agentRoles }), project()))).toEqual([
      "claude-agent is not available: no SDK",
    ]);
  });

  it("saves a role choice of claude-agent as an ordinary roles patch", () => {
    const base = agentsPage.values(settings(), project());
    const form = { ...base, global: { ...base.global, roles: agentRoles } };
    const patch = agentsPage.patches(form, base, { settings: settings(), project: project() });
    expect(patch.settings?.roles?.developer).toEqual({ tool: "claude-agent", model: "default" });
  });
});
