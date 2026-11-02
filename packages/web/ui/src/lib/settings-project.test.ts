import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { projectPage } from "./settings-project.js";

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
