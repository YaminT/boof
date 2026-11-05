import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@boof/heart/schema";
import { makeProjectPage, projectPage } from "./settings-project.js";

const settings = { defaultProject: null, projectsRoot: undefined } as unknown as Settings;
const project = {
  id: "alpha",
  name: "Alpha",
  workingDirectory: "/repo/alpha",
  paused: false,
} as unknown as Project;
const latest = { settings, project };

describe("projectPage", () => {
  it("reads missing optional values as empty strings", () => {
    const v = projectPage.values(settings, project);
    expect(v.global).toEqual({ defaultProject: "", projectsRoot: "" });
    expect(v.project).toEqual({
      name: "Alpha",
      workingDirectory: "/repo/alpha",
      defaultBase: "",
      brief: "",
      paused: false,
      claudeAuth: "gateway",
      anthropicApiKey: "",
      removeApiKey: false,
    });
  });

  it("a clean form sends nothing", () => {
    const v = projectPage.values(settings, project);
    expect(projectPage.patches(v, v, latest)).toEqual({});
  });

  it("clears the brief when it is only blanks", () => {
    const base = projectPage.values(settings, { ...project, brief: "old" });
    const form = { ...base, project: { ...base.project, brief: "  " } };
    expect(projectPage.patches(form, base, latest)).toEqual({ project: { brief: null } });
  });

  it("clears the projects root with an empty value", () => {
    const base = projectPage.values({ ...settings, projectsRoot: "/p" }, project);
    const form = { ...base, global: { ...base.global, projectsRoot: "" } };
    expect(projectPage.patches(form, base, latest)).toEqual({ settings: { projectsRoot: null } });
  });

  it("sends only the fields that changed, trimmed", () => {
    const base = projectPage.values(settings, project);
    const form = {
      global: { ...base.global, defaultProject: "alpha" },
      project: { ...base.project, name: " Beta ", paused: true },
    };
    expect(projectPage.patches(form, base, latest)).toEqual({
      settings: { defaultProject: "alpha" },
      project: { name: "Beta", paused: true },
    });
  });

  it("does not send a working directory that equals the latest one after trimming", () => {
    const base = projectPage.values(settings, project);
    const form = { ...base, project: { ...base.project, workingDirectory: " /repo/alpha " } };
    expect(projectPage.patches(form, base, latest)).toEqual({});
    const moved = { ...base, project: { ...base.project, workingDirectory: "/repo/new" } };
    expect(projectPage.patches(moved, base, latest)).toEqual({
      project: { workingDirectory: "/repo/new" },
    });
  });

  it("explains what stops a save", () => {
    const base = projectPage.values(settings, project);
    const bad = { ...base, project: { ...base.project, name: " ", workingDirectory: "" } };
    expect(projectPage.problems(bad)).toEqual([
      "Give the project a name.",
      "Enter the project's working directory.",
    ]);
    expect(projectPage.problems(base)).toEqual([]);
  });
});

describe("projectPage: Claude Agent SDK", () => {
  const key = "sk-ant-api03-" + "k".repeat(40);
  const base = projectPage.values(settings, project);
  const edit = (patch: Partial<typeof base.project>) => ({
    ...base,
    project: { ...base.project, ...patch },
  });

  it("reads the stored auth choice, defaults to the gateway and never holds a key", () => {
    expect(base.project.claudeAuth).toBe("gateway");
    const own = projectPage.values(settings, {
      ...project,
      claudeAgent: { auth: "project-key" },
    } as Project);
    expect(own.project.claudeAuth).toBe("project-key");
    expect(own.project.anthropicApiKey).toBe("");
    expect(JSON.stringify(own)).not.toContain("sk-ant");
  });

  it("patches claudeAgent when the choice changes", () => {
    expect(projectPage.patches(edit({ claudeAuth: "project-key" }), base, latest)).toEqual({
      project: { claudeAgent: { auth: "project-key" } },
    });
  });

  it("sends anthropicApiKey only when a key was typed", () => {
    expect(projectPage.patches(base, base, latest)).toEqual({});
    expect(projectPage.patches(edit({ anthropicApiKey: "" }), base, latest)).toEqual({});
    expect(projectPage.patches(edit({ anthropicApiKey: "   " }), base, latest)).toEqual({});
    expect(projectPage.patches(edit({ anthropicApiKey: ` ${key} ` }), base, latest)).toEqual({
      project: { anthropicApiKey: key },
    });
  });

  it("sends null to remove the key, and a typed key replaces rather than removes", () => {
    expect(projectPage.patches(edit({ removeApiKey: true }), base, latest)).toEqual({
      project: { anthropicApiKey: null },
    });
    expect(
      projectPage.patches(edit({ removeApiKey: true, anthropicApiKey: key }), base, latest),
    ).toEqual({ project: { anthropicApiKey: key } });
  });

  it("blocks Save on a typed value that is not an API key, without repeating it", () => {
    const bad = "sk-ant-oat01-" + "t".repeat(40);
    const problems = projectPage.problems(edit({ anthropicApiKey: bad }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toContain(bad);
    expect(projectPage.problems(edit({ anthropicApiKey: key }))).toEqual([]);
  });

  it("on the desktop app hides the fields and produces no claudeAgent or key patch", () => {
    const desktop = makeProjectPage({ isDesktop: true });
    const form = edit({ claudeAuth: "project-key", anthropicApiKey: key, name: "Beta" });
    expect(desktop.patches(form, base, latest)).toEqual({ project: { name: "Beta" } });
    expect(desktop.patches(edit({ removeApiKey: true }), base, latest)).toEqual({});
    expect(desktop.problems(edit({ anthropicApiKey: "garbage" }))).toEqual([]);
  });
});
