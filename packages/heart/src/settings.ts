import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { lockedAtomicWrite, readText, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";
import {
  ConciergeSettingsSchema,
  McpSettingsSchema,
  RetrySettingsSchema,
  ReviewSettingsSchema,
  SecuritySettingsSchema,
  SettingsSchema,
  UpdatesSettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  WorktreeSettingsSchema,
  type ConciergeSettings,
  type McpSettings,
  type OrchestrationProfile,
  type Project,
  type RetrySettings,
  type ReviewSettings,
  type RoleAssignment,
  type SecuritySettings,
  type Settings,
  type UpdatesSettings,
  type WorktreeSettings,
} from "./schema.js";
import type { Role } from "./schema.js";
import type { Task } from "./task-file.js";

/** Default (v2) settings used when scaffolding a fresh data root: no projects. */
export function defaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    runner: {
      enabled: false,
      concurrency: 1,
      inheritMcpServers: false,
      sandbox: { mode: "off", readPaths: [], writePaths: [], denyTcpPorts: [] },
    },
    defaultProject: null,
    roles: {
      planner: { tool: "claude-code", model: "opus" },
      developer: { tool: "codex", model: "" },
      reviewer: { tool: "claude-code", model: "sonnet" },
    },
    models: {
      // claude CLI --model aliases (map to the latest of each tier). Full IDs
      // like "claude-opus-4-8" also work; aliases survive model bumps.
      "claude-code": ["opus", "sonnet", "haiku"],
      codex: [],
      opencode: ["opencode-go/kimi-k3"],
      "claude-agent": ["default"],
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
    // A missing file reads as the defaults and is not created here: a read (a GET, /healthz) must
    // not write. Startup and the first update create it.
    if (!(await exists(this.path))) return defaultSettings();
    const raw: unknown = JSON.parse(await readText(this.path));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (!("schemaVersion" in raw)) {
        throw new Error(
          `${this.path} is a v1 settings file; start boof-runner (any command) to migrate the data root to v2`,
        );
      }
      // 2 is a 0.3.0 file. Name it before Zod, which would dump a multi-line error for the
      // literal. Every command migrates first; this is the message when one did not.
      if (raw.schemaVersion === 2) {
        throw new Error(
          `${this.path} is a 0.3.0 settings file; start boof-runner (any command) to migrate the data root`,
        );
      }
    }
    return SettingsSchema.parse(raw);
  }

  async save(settings: Settings): Promise<Settings> {
    const validated = SettingsSchema.parse(settings);
    const inconsistent = profileConsistency(validated);
    if (inconsistent) throw new Error(inconsistent);
    await lockedAtomicWrite(this.path, JSON.stringify(validated, null, 2) + "\n");
    return validated;
  }

  /**
   * Partial update merged over the current settings. `runner` merges per key, and `runner.sandbox`
   * merges per key too, so changing `mode` does not clear the path lists. `guard` runs on the
   * current settings under the same lock, before the merge: it throws to refuse the write.
   */
  update(
    patch: SettingsUpdate,
    guard?: (current: Settings) => void,
    validate?: (current: Settings, next: Settings) => void,
  ): Promise<Settings> {
    return this.mutate((current) => {
      guard?.(current);
      const { runner, projectsRoot, owlish, ...rest } = patch;
      const next = {
        ...current,
        ...rest,
        ...(runner ? { runner: mergeRunner(current.runner, runner) } : {}),
      } as Settings;
      // `null` clears the projects root back to its default.
      if (owlish === null) delete next.owlish;
      else if (owlish !== undefined) next.owlish = owlish;
      if (projectsRoot === null) delete next.projectsRoot;
      else if (projectsRoot !== undefined) next.projectsRoot = projectsRoot;
      // `null` switches back to the plain roles.
      if (next.activeProfile === null) delete next.activeProfile;
      validate?.(current, next);
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

/**
 * A short token of the settings a client can read (everything but the webhook list and the n8n block,
 * which have their own operations and are never sent to clients): it changes whenever one of them does. The ETag of GET/PUT /settings.
 */
export function settingsVersion(settings: { webhooks?: unknown; n8n?: unknown }): string {
  const { webhooks: _w, n8n: _n, ...visible } = settings;
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex").slice(0, 16);
}

/** What {@link SettingsStore.update} accepts: any settings key, `runner` partial, `projectsRoot` nullable. */
export type SettingsUpdate = Omit<Partial<Settings>, "runner" | "projectsRoot" | "owlish"> & {
  runner?: Partial<Omit<Settings["runner"], "sandbox">> & {
    sandbox?: Partial<Settings["runner"]["sandbox"]>;
  };
  projectsRoot?: string | null;
  /** `null` removes the account pool. */
  owlish?: Settings["owlish"] | null;
};

function mergeRunner(
  current: Settings["runner"],
  patch: NonNullable<SettingsUpdate["runner"]>,
): Settings["runner"] {
  const { sandbox, ...rest } = patch;
  const next = { ...current, ...stripUndefined(rest) };
  if (sandbox) next.sandbox = { ...current.sandbox, ...stripUndefined(sandbox) };
  return next;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The profile a task resolves roles from: the project's choice, else the global active one. */
export function activeProfileFor(
  settings: Pick<Settings, "profiles" | "activeProfile">,
  projectProfile?: string | null,
): OrchestrationProfile | undefined {
  const id = projectProfile ?? settings.activeProfile;
  if (!id) return undefined;
  return settings.profiles?.find((profile) => profile.id === id);
}

/**
 * Resolve a role with "off" kept: task `tools` override, then the project's own role override, then
 * the profile (project's, else the active one), then `settings.roles`. A profile role of `null`
 * returns `null` (the role is off). With no profiles this is exactly the 0.5.0 order. Pass settings
 * from {@link effectiveSettings} so the project's choices apply.
 */
export function resolveRoleOrOff(
  settings: Settings | EffectiveSettings,
  task: Task,
  role: Role,
): RoleAssignment | null | undefined {
  const own = task.frontmatter.tools?.[role];
  if (own) return own;
  const eff = settings as Partial<EffectiveSettings>;
  const fromProject = eff.projectRoles?.[role];
  if (fromProject) return fromProject;
  const profile = activeProfileFor(settings, eff.projectProfile);
  if (profile) return profile.roles[role];
  return settings.roles[role];
}

/**
 * Resolve the tool+model for a role. Callers written before profiles still get an assignment for
 * the planner and reviewer, so a profile that turns one off is read there as the plain
 * `settings.roles` one; use {@link resolveRoleOrOff} to see "off". The observer resolves to
 * undefined when unset or off.
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
  return (
    resolveRoleOrOff(settings, task, role) ??
    (role === "observer" ? undefined : settings.roles[role])
  );
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

/** Concierge settings with defaults applied. `defaultSettings()` does not store this block. */
export function conciergeSettings(s: Settings): ConciergeSettings {
  return ConciergeSettingsSchema.parse(s.concierge ?? {});
}

/** Security settings with defaults applied. */
export function securitySettings(settings: Settings): SecuritySettings {
  return SecuritySettingsSchema.parse(settings.security ?? {});
}

/** Release-check settings. Absent means on: the server may ask GitHub at most once a day. */
export function updatesSettings(settings: Settings): UpdatesSettings {
  return UpdatesSettingsSchema.parse(settings.updates ?? {});
}

/** Settings of one project: the global settings with the project's overrides and working directory. */
export type EffectiveSettings = Settings & {
  workingDirectory: string;
  claudeAgent?: Project["claudeAgent"];
  /** The project's own role overrides, kept apart so they beat a profile (see resolveRoleOrOff). */
  projectRoles?: Project["roles"];
  /** The project's chosen profile id, if any. */
  projectProfile?: string;
};

/**
 * Merge a project over the global settings. `roles`, `review`, `worktree`, `retries` and `budget` merge
 * per key (the project wins); everything else is global. Adds `workingDirectory`.
 */
export function effectiveSettings(global: Settings, project: Project): EffectiveSettings {
  const merged: EffectiveSettings = { ...global, workingDirectory: project.workingDirectory };
  if (project.claudeAgent) merged.claudeAgent = project.claudeAgent;
  if (project.profile) merged.projectProfile = project.profile;
  if (project.roles) {
    merged.projectRoles = project.roles;
    merged.roles = { ...global.roles, ...definedOnly(project.roles) };
  }
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

/** What a settings write must satisfy beyond the schema; see {@link checkProfiles}. */
export interface ProfileCheckContext {
  /** Tool ids that exist; unknown ones are refused. Omit to skip the check. */
  knownTools?: readonly string[];
  /** Projects and the profile each one chose. */
  projects: readonly { id: string; profile?: string }[];
}

/** Duplicate profile ids, or an `activeProfile` that does not exist; null when consistent. */
export function profileConsistency(
  settings: Pick<Settings, "profiles" | "activeProfile">,
): string | null {
  const ids = new Set<string>();
  for (const profile of settings.profiles ?? []) {
    if (ids.has(profile.id)) return `Duplicate profile id: ${profile.id}`;
    ids.add(profile.id);
  }
  if (settings.activeProfile && !ids.has(settings.activeProfile)) {
    return `activeProfile does not exist: ${settings.activeProfile}`;
  }
  return null;
}

export type ProfileProblem =
  | { code: "invalid_profiles" | "unknown_tool"; message: string }
  | { code: "profile_in_use"; message: string; projects: string[] };

/**
 * Check a settings change that touches profiles: every profile role names a known tool, and no
 * profile that a project uses is removed. Returns the first problem, or null.
 */
export function checkProfiles(
  current: Settings,
  next: Settings,
  ctx: ProfileCheckContext,
): ProfileProblem | null {
  const inconsistent = profileConsistency(next);
  if (inconsistent) return { code: "invalid_profiles", message: inconsistent };
  const known = ctx.knownTools ? new Set(ctx.knownTools) : undefined;
  if (known) {
    for (const profile of next.profiles ?? []) {
      for (const [role, assignment] of Object.entries(profile.roles)) {
        if (assignment && !known.has(assignment.tool)) {
          return {
            code: "unknown_tool",
            message: `Profile "${profile.id}" role ${role}: unknown tool "${assignment.tool}"`,
          };
        }
      }
    }
  }
  const kept = new Set((next.profiles ?? []).map((profile) => profile.id));
  const removed = new Set(
    (current.profiles ?? []).map((profile) => profile.id).filter((id) => !kept.has(id)),
  );
  if (removed.size > 0) {
    const users = ctx.projects.filter((p) => p.profile !== undefined && removed.has(p.profile));
    if (users.length > 0) {
      return {
        code: "profile_in_use",
        message: `Profile is used by: ${users.map((p) => p.id).join(", ")}`,
        projects: users.map((p) => p.id),
      };
    }
  }
  return null;
}
