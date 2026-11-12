import { describe, expect, it } from "vitest";
import type { OrchestrationProfile, Project, Settings } from "@boof/heart/schema";
import { OrchestrationProfileSchema } from "@boof/heart/schema";
import {
  deleteProfile,
  duplicateProfile,
  newProfile,
  profileProblems,
  profileSummary,
  profilesPage,
  projectsUsing,
  setProfileRole,
  uniqueProfileId,
} from "./profiles.js";

const roles = {
  planner: { tool: "claude-code", model: "opus" },
  developer: { tool: "claude-code", model: "haiku" },
  reviewer: { tool: "codex", model: "" },
} as Settings["roles"];
const settings = { roles, profiles: [], activeProfile: null } as unknown as Settings;
const project = { id: "alpha", name: "Alpha" } as Project;
const latest = { settings, project };

describe("templates", () => {
  it("current roles copies settings.roles; a missing observer is off", () => {
    const p = newProfile("current", settings, []);
    expect(p.name).toBe("Current roles");
    expect(p.roles).toEqual({ ...roles, observer: null });
    expect(p.roles.developer).not.toBe(roles.developer);
    expect(OrchestrationProfileSchema.safeParse(p).success).toBe(true);
  });
  it("developer only keeps the developer and turns the rest off", () => {
    const p = newProfile("developer-only", settings, []);
    expect(p.roles).toEqual({
      planner: null,
      developer: roles.developer,
      observer: null,
      reviewer: null,
    });
    expect(OrchestrationProfileSchema.safeParse(p).success).toBe(true);
  });
  it("names and ids stay unique", () => {
    const a = newProfile("developer-only", settings, []);
    const b = newProfile("developer-only", settings, [a]);
    expect(b.name).toBe("Developer only 2");
    expect(b.id).toBe("developer-only-2");
  });
});

describe("ids and duplicates", () => {
  it("makes kebab ids", () => {
    expect(uniqueProfileId("Fast & Cheap!", [])).toBe("fast-cheap");
    expect(uniqueProfileId("***", [])).toBe("profile");
    expect(uniqueProfileId("a", ["a", "a-2"])).toBe("a-3");
  });
  it("duplicate is a deep copy under a new name and id", () => {
    const p = newProfile("current", settings, []);
    const d = duplicateProfile(p, [p]);
    expect(d.name).toBe("Current roles copy");
    expect(d.id).toBe("current-roles-copy");
    expect(d.roles).toEqual(p.roles);
    expect(d.roles.developer).not.toBe(p.roles.developer);
  });
});

describe("editing", () => {
  const p = newProfile("current", settings, []);
  it("turns a role off and back on without touching the others", () => {
    const off = setProfileRole([p], p.id, "reviewer", null);
    expect(off[0].roles.reviewer).toBeNull();
    expect(off[0].roles.developer).toEqual(p.roles.developer);
    expect(p.roles.reviewer).not.toBeNull();
  });
  it("summarises roles, with off roles named", () => {
    const dev = newProfile("developer-only", settings, []);
    expect(profileSummary(dev)).toBe("Advisor: off · Developer: claude-code haiku · Reviewer: off");
  });
});

describe("delete", () => {
  const a = newProfile("current", settings, []);
  const used = { id: "alpha", name: "Alpha", profile: a.id } as Project;
  it("is refused while a project uses it, naming the project", () => {
    const out = deleteProfile({ profiles: [a], activeProfile: null }, a.id, [used, project]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.projects).toEqual(["Alpha"]);
      expect(out.message).toContain("Alpha");
    }
    expect(projectsUsing([used, project], a.id)).toHaveLength(1);
  });
  it("removes it and clears the active choice", () => {
    const out = deleteProfile({ profiles: [a], activeProfile: a.id }, a.id, [project]);
    expect(out).toEqual({ ok: true, values: { profiles: [], activeProfile: null } });
  });
  it("keeps another profile active", () => {
    const b = { ...a, id: "b", name: "B" };
    const out = deleteProfile({ profiles: [a, b], activeProfile: "b" }, a.id, []);
    expect(out).toEqual({ ok: true, values: { profiles: [b], activeProfile: "b" } });
  });
});

describe("problems", () => {
  const a = newProfile("current", settings, []);
  it("a clean list has none", () => {
    expect(
      profileProblems({ profiles: [a], activeProfile: a.id }, ["claude-code", "codex"]),
    ).toEqual([]);
  });
  it("blank, repeated and over-long names", () => {
    const blank = { ...a, id: "x", name: "  " };
    const same = { ...a, id: "y", name: a.name.toUpperCase() };
    expect(profileProblems({ profiles: [blank], activeProfile: null })).toContain(
      "Give every profile a name.",
    );
    expect(profileProblems({ profiles: [a, same], activeProfile: null }).join()).toContain(
      "Two profiles are called",
    );
    expect(
      profileProblems({ profiles: [{ ...a, name: "x".repeat(61) }], activeProfile: null }),
    ).toHaveLength(1);
  });
  it("an unknown tool or a missing active profile", () => {
    expect(profileProblems({ profiles: [a], activeProfile: null }, ["codex"]).join()).toContain(
      "claude-code, which does not exist",
    );
    expect(profileProblems({ profiles: [a], activeProfile: "gone" })).toEqual([
      "The profile in use does not exist.",
    ]);
  });
});

describe("profilesPage", () => {
  const a = newProfile("current", settings, []);
  const base = profilesPage.values(settings, project);
  it("reads absent keys as none", () => {
    expect(base.global).toEqual({ profiles: [], activeProfile: null });
  });
  it("a clean form sends nothing", () => {
    expect(profilesPage.patches(base, base, latest)).toEqual({});
  });
  it("sends the whole list and the active id when they change", () => {
    const form = { ...base, global: { profiles: [a], activeProfile: a.id } };
    expect(profilesPage.patches(form, base, latest)).toEqual({
      settings: { profiles: [a], activeProfile: a.id },
    });
  });
  it("sends only the active id when only it changed", () => {
    const b0 = { ...base, global: { profiles: [a], activeProfile: null } };
    const form = { ...b0, global: { ...b0.global, activeProfile: a.id } };
    expect(profilesPage.patches(form, b0, latest)).toEqual({ settings: { activeProfile: a.id } });
  });
  it("sends activeProfile null when the active one is dropped", () => {
    const b0 = { ...base, global: { profiles: [a], activeProfile: a.id } };
    const form = { ...b0, global: { profiles: [] as OrchestrationProfile[], activeProfile: null } };
    expect(profilesPage.patches(form, b0, latest)).toEqual({
      settings: { profiles: [], activeProfile: null },
    });
  });
});
