import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { lockedAtomicWrite, readText, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";
import {
  McpSettingsSchema,
  RetrySettingsSchema,
  ReviewSettingsSchema,
  SecuritySettingsSchema,
  SettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  WorktreeSettingsSchema,
  type McpSettings,
  type Project,
  type RetrySettings,
  type ReviewSettings,
  type RoleAssignment,
  type SecuritySettings,
  type Settings,
  type WorktreeSettings,
} from "./schema.js";
import type { Role } from "./schema.js";
import type { Task } from "./task-file.js";

/** Default (v2) settings used when scaffolding a fresh data root: no projects. */
export function defaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    runner: { enabled: false, concurrency: 1 },
    defaultProject: null,
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
      opencode: ["opencode-go/kimi-k3"],
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
    this.path = dataRootPaths(root).settings;
  }

  async load(): Promise<Settings> {
    if (!(await exists(this.path))) {
      const s = defaultSettings();
      await this.save(s);
      return s;
    }
    const raw: unknown = JSON.parse(await readText(this.path));
    if (raw && typeof raw === "object" && !("schemaVersion" in raw)) {
      throw new Error(
        `${this.path} is a v1 settings file; start boof-runner (any command) to migrate the data root to v2`,
      );
    }
    return SettingsSchema.parse(raw);
  }

  async save(settings: Settings): Promise<Settings> {
    const validated = SettingsSchema.parse(settings);
    await lockedAtomicWrite(this.path, JSON.stringify(validated, null, 2) + "\n");
    return validated;
  }

  /** Partial update merged over the current settings; `runner` merges per key. */
  update(patch: SettingsUpdate): Promise<Settings> {
    return this.mutate((current) => {
      const { runner, projectsRoot, ...rest } = patch;
      const next = {
        ...current,
        ...rest,
        ...(runner ? { runner: { ...current.runner, ...stripUndefined(runner) } } : {}),
      } as Settings;
      // `null` clears the projects root back to its default.
      if (projectsRoot === null) delete next.projectsRoot;
      else if (projectsRoot !== undefined) next.projectsRoot = projectsRoot;
      return next;
    });
  }

  /**
   * Load, change and save under one lock so concurrent updates in this process cannot lose each
   * other. `fn` returns the settings to store. Every load-then-save of settings must use this
   * instead of `load` followed by `save`.
   */
  mutate(fn: (current: Settings) => Settings | Promise<Settings>): Promise<Settings> {
    return withFileLock(`${this.path}#mutate`, async () => this.save(await fn(await this.load())));
  }
}

/** What {@link SettingsStore.update} accepts: any settings key, `runner` partial, `projectsRoot` nullable. */
export type SettingsUpdate = Omit<Partial<Settings>, "runner" | "projectsRoot"> & {
  runner?: Partial<Settings["runner"]>;
  projectsRoot?: string | null;
};

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Resolve the tool+model for a role: a per-task `tools` override wins over the
 * global `settings.roles` assignment (settings spec). The observer is optional,
 * so it resolves to undefined when unset in both places.
 */
export function resolveRole(
  settings: Settings,
  task: Task,
  role: "observer",
): RoleAssignment | undefined;
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

/** Worktree settings with defaults applied. */
export function worktreeSettings(settings: Settings): WorktreeSettings {
  return WorktreeSettingsSchema.parse(settings.worktree ?? {});
}

/** Retry settings with defaults applied. */
export function retrySettings(settings: Settings): RetrySettings {
  return RetrySettingsSchema.parse(settings.retries ?? {});
}

/** MCP settings with defaults applied. */
export function mcpSettings(settings: Settings): McpSettings {
  return McpSettingsSchema.parse(settings.mcp ?? {});
}

/** Security settings with defaults applied. */
export function securitySettings(settings: Settings): SecuritySettings {
  return SecuritySettingsSchema.parse(settings.security ?? {});
}

/** Settings of one project: the global settings with the project's overrides and working directory. */
export type EffectiveSettings = Settings & { workingDirectory: string };

/**
 * Merge a project over the global settings. `roles`, `review`, `worktree`, `retries` and `budget` merge
 * per key (the project wins); everything else is global. Adds `workingDirectory`.
 */
export function effectiveSettings(global: Settings, project: Project): EffectiveSettings {
  const merged: EffectiveSettings = { ...global, workingDirectory: project.workingDirectory };
  if (project.roles) merged.roles = { ...global.roles, ...definedOnly(project.roles) };
  if (project.review) merged.review = { ...global.review, ...definedOnly(project.review) } as never;
  if (project.worktree) {
    merged.worktree = { ...global.worktree, ...definedOnly(project.worktree) } as never;
  }
  if (project.budget) {
    // A project's own `perToolDayUsd` caps its spend only; the global per-tool limits stay global.
    const { perToolDayUsd: _own, ...rest } = definedOnly(project.budget);
    merged.budget = { onExceed: "pause", ...global.budget, ...rest };
  }
  if (project.retries) {
    merged.retries = { ...global.retries, ...definedOnly(project.retries) } as never;
  }
  return merged;
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return stripUndefined(o);
}

/**
 * Absolute directory holding task worktrees. Unset: `<workingDirectory>/.boof-runner-worktrees`.
 * `~` and `~/x` expand to the home directory; a relative path resolves against workingDirectory.
 */
export function resolveWorktreeRoot(
  worktree: Pick<WorktreeSettings, "root">,
  workingDirectory: string,
): string {
  const root = worktree.root;
  if (!root) return join(workingDirectory, ".boof-runner-worktrees");
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return join(homedir(), root.slice(2));
  return isAbsolute(root) ? root : resolve(workingDirectory, root);
}
