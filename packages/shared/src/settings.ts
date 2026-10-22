import { stat } from "node:fs/promises";
import { lockedAtomicWrite, readText } from "./atomic.js";
import { dataPaths } from "./paths.js";
import {
  ReviewSettingsSchema,
  SettingsSchema,
  type ReviewSettings,
  type RoleAssignment,
  type Settings,
} from "./schema.js";
import type { Role } from "./schema.js";
import type { Task } from "./task-file.js";

/** Default settings used when scaffolding a fresh data root. */
export function defaultSettings(workingDirectory = process.cwd()): Settings {
  return {
    runner: { enabled: false },
    workingDirectory,
    selectedSubdirectory: null,
    blockHours: [],
    tokens: {},
    roles: {
      planner: { tool: "claude-code", model: "opus" },
      developer: { tool: "codex", model: "gpt-5.5" },
      reviewer: { tool: "claude-code", model: "sonnet" },
    },
    models: {
      // claude CLI --model aliases (map to the latest of each tier). Full IDs
      // like "claude-opus-4-8" also work; aliases survive model bumps.
      "claude-code": ["opus", "sonnet", "haiku"],
      codex: ["gpt-5.5"],
      mock: ["mock-default"],
    },
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class SettingsStore {
  private readonly path: string;
  constructor(root: string) {
    this.path = dataPaths(root).settings;
  }

  async load(): Promise<Settings> {
    if (!(await exists(this.path))) {
      const s = defaultSettings();
      await this.save(s);
      return s;
    }
    return SettingsSchema.parse(JSON.parse(await readText(this.path)));
  }

  async save(settings: Settings): Promise<Settings> {
    const validated = SettingsSchema.parse(settings);
    await lockedAtomicWrite(this.path, JSON.stringify(validated, null, 2) + "\n");
    return validated;
  }

  /** Partial update merged over the current settings. */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.load();
    return this.save({ ...current, ...patch });
  }
}

/**
 * Resolve the tool+model for a role: a per-task `tools` override wins over the
 * global `settings.roles` assignment (settings spec). The observer is optional,
 * so it resolves to undefined when unset in both places.
 */
export function resolveRole(settings: Settings, task: Task, role: "observer"): RoleAssignment | undefined;
export function resolveRole(
  settings: Settings,
  task: Task,
  role: Exclude<Role, "observer">,
): RoleAssignment;
export function resolveRole(
  settings: Settings,
  task: Task,
  role: Role,
): RoleAssignment | undefined {
  return task.frontmatter.tools?.[role] ?? settings.roles[role];
}

/** Observer assignment (per-task override, then global), or undefined when unset. */
export function resolveObserver(settings: Settings, task: Task): RoleAssignment | undefined {
  return resolveRole(settings, task, "observer");
}

/** Review settings with defaults applied (the only place defaults are read). */
export function reviewSettings(settings: Settings): ReviewSettings {
  return ReviewSettingsSchema.parse(settings.review ?? {});
}
