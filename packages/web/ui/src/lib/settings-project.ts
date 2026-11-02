import type { ProjectPatch, SettingsPatch } from "@boof-runner/shared/schema";
import { changedKeys, type PageModel, type PageValues } from "./settings-draft.js";

export type ProjectPageValues = PageValues<
  { defaultProject: string; projectsRoot: string },
  { name: string; workingDirectory: string; defaultBase: string; brief: string; paused: boolean }
>;

/** Settings › Project: the project's own fields and the two settings that are about projects. */
export const projectPage: PageModel<ProjectPageValues> = {
  values: (s, p) => ({
    global: { defaultProject: s.defaultProject ?? "", projectsRoot: s.projectsRoot ?? "" },
    project: {
      name: p.name,
      workingDirectory: p.workingDirectory,
      defaultBase: p.defaultBase ?? "",
      brief: p.brief ?? "",
      paused: p.paused,
    },
  }),

  problems: (v) => {
    const out: string[] = [];
    if (!v.project.name.trim()) out.push("Give the project a name.");
    if (!v.project.workingDirectory.trim()) out.push("Enter the project's working directory.");
    return out;
  },

  patches: (form, base, latest) => {
    const settings: SettingsPatch = {};
    for (const k of changedKeys(form.global, base.global)) {
      if (k === "defaultProject") settings.defaultProject = form.global.defaultProject || null;
      if (k === "projectsRoot") settings.projectsRoot = form.global.projectsRoot.trim() || null;
    }
    const project: ProjectPatch = {};
    for (const k of changedKeys(form.project, base.project)) {
      const v = form.project;
      if (k === "name") project.name = v.name.trim();
      if (k === "defaultBase") project.defaultBase = v.defaultBase.trim() || null;
      if (k === "brief") project.brief = v.brief.trim() || null;
      if (k === "paused") project.paused = v.paused;
      if (k === "workingDirectory") {
        const dir = v.workingDirectory.trim();
        if (dir && dir !== latest.project.workingDirectory) project.workingDirectory = dir;
      }
    }
    return {
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(Object.keys(project).length > 0 ? { project } : {}),
    };
  },
};
