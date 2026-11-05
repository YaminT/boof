import type { SettingsPatch } from "@boof/heart/schema";
import { isApiKeyShape } from "./claude-agent.js";
import {
  changedKeys,
  type PagePatches,
  type PageModel,
  type PageValues,
} from "./settings-draft.js";

export type ClaudeAuth = "gateway" | "project-key";

export type ProjectPageValues = PageValues<
  { defaultProject: string; projectsRoot: string },
  {
    name: string;
    workingDirectory: string;
    defaultBase: string;
    brief: string;
    paused: boolean;
    /** How claude-agent authenticates for this project. */
    claudeAuth: ClaudeAuth;
    /** A key typed by the user. Write-only: it starts empty and is never filled from the server. */
    anthropicApiKey: string;
    /** Remove the stored key when saving. */
    removeApiKey: boolean;
  }
>;

/** What the project page shows about claude-agent: only the explanation on the desktop app. */
export function claudeAgentSectionMode(env: { isDesktop?: boolean }): "settings" | "desktop-note" {
  return env.isDesktop ? "desktop-note" : "settings";
}

/** Settings › Project: the project's own fields and the two settings that are about projects. */
export const makeProjectPage = (
  env: { isDesktop?: boolean } = {},
): PageModel<ProjectPageValues> => ({
  values: (s, p) => ({
    global: { defaultProject: s.defaultProject ?? "", projectsRoot: s.projectsRoot ?? "" },
    project: {
      name: p.name,
      workingDirectory: p.workingDirectory,
      defaultBase: p.defaultBase ?? "",
      brief: p.brief ?? "",
      paused: p.paused,
      claudeAuth: p.claudeAgent?.auth ?? "gateway",
      anthropicApiKey: "",
      removeApiKey: false,
    },
  }),

  problems: (v) => {
    const out: string[] = [];
    if (!v.project.name.trim()) out.push("Give the project a name.");
    if (!v.project.workingDirectory.trim()) out.push("Enter the project's working directory.");
    const key = v.project.anthropicApiKey.trim();
    if (claudeAgentSectionMode(env) === "settings" && key && !isApiKeyShape(key))
      out.push("That is not an Anthropic API key. It starts with sk-ant-api.");
    return out;
  },

  patches: (form, base, latest) => {
    const settings: SettingsPatch = {};
    for (const k of changedKeys(form.global, base.global)) {
      if (k === "defaultProject") settings.defaultProject = form.global.defaultProject || null;
      if (k === "projectsRoot") settings.projectsRoot = form.global.projectsRoot.trim() || null;
    }
    const project: NonNullable<PagePatches["project"]> = {};
    const agentFields = claudeAgentSectionMode(env) === "settings";
    for (const k of changedKeys(form.project, base.project)) {
      const v = form.project;
      if (k === "name") project.name = v.name.trim();
      if (k === "defaultBase") project.defaultBase = v.defaultBase.trim() || null;
      if (k === "brief") project.brief = v.brief.trim() || null;
      if (k === "paused") project.paused = v.paused;
      // Never on the desktop app, which has no claude-agent. The key goes out only when typed.
      if (agentFields) {
        if (k === "claudeAuth") project.claudeAgent = { auth: v.claudeAuth };
        if (k === "anthropicApiKey" && v.anthropicApiKey.trim())
          project.anthropicApiKey = v.anthropicApiKey.trim();
        if (k === "removeApiKey" && v.removeApiKey && !v.anthropicApiKey.trim())
          project.anthropicApiKey = null;
      }
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
});

export const projectPage = makeProjectPage();
