import type { Project, Role, RoleAssignment, Settings } from "@boof-runner/shared";
import type { CachedHealth } from "@boof-runner/runner";

const ROLES: Role[] = ["planner", "developer", "observer", "reviewer"];

export type ModelSource = "cli" | "default" | "settings";

export interface ModelDetail {
  id: string;
  source: ModelSource;
  isDefault: boolean;
  usedBy: string[];
}

export interface ToolModelDetails {
  displayName: string;
  health: CachedHealth | null;
  models: ModelDetail[];
}

export interface ModelDetailsInput {
  /** Registered tools (id, display name, built-in default models). */
  tools: { id: string; displayName: string; defaultModels: readonly string[] }[];
  /** What each tool's listModels() returned now; a tool with no live list maps to []. */
  live: Record<string, string[]>;
  /** Global settings: the role assignments and the user-listed models. */
  settings: Pick<Settings, "roles" | "models">;
  /** Projects the caller may see (their overrides count towards usedBy). */
  projects: Pick<Project, "id" | "roles">[];
  /** Last health result per tool id (absent when no check ran in this process). */
  health: Record<string, CachedHealth>;
}

/**
 * Per tool, the models it offers with where each came from, whether it is the default, and which
 * roles use it. A model's source is the first of: live CLI list, built-in defaults, settings.
 * A model that only a role names (no list has it) is reported as a settings model.
 */
export function buildModelDetails(input: ModelDetailsInput): Record<string, ToolModelDetails> {
  const out: Record<string, ToolModelDetails> = {};
  for (const tool of input.tools) {
    const live = input.live[tool.id] ?? [];
    const defaults = [...tool.defaultModels];
    const ids = unique([
      ...live,
      ...defaults,
      ...(input.settings.models[tool.id] ?? []),
      ...ROLES.flatMap((role) => {
        const a = input.settings.roles[role];
        return a?.tool === tool.id ? [a.model] : [];
      }),
      ...input.projects.flatMap((p) =>
        ROLES.flatMap((role) => {
          const a = p.roles?.[role];
          return a?.tool === tool.id ? [a.model] : [];
        }),
      ),
    ]);
    out[tool.id] = {
      displayName: tool.displayName,
      health: input.health[tool.id] ?? null,
      models: ids.map((id) => ({
        id,
        source: live.includes(id) ? "cli" : defaults.includes(id) ? "default" : "settings",
        isDefault: defaults.length > 0 && id === defaults[0],
        usedBy: usedBy(tool.id, id, input),
      })),
    };
  }
  return out;
}

function usedBy(tool: string, model: string, input: ModelDetailsInput): string[] {
  const out: string[] = [];
  for (const role of ROLES) {
    if (matches(input.settings.roles[role], tool, model)) out.push(role);
  }
  for (const p of input.projects) {
    for (const role of ROLES) {
      if (matches(p.roles?.[role], tool, model)) out.push(`project:${p.id}:${role}`);
    }
  }
  return out;
}

function matches(a: RoleAssignment | undefined, tool: string, model: string): boolean {
  return a?.tool === tool && a.model === model;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
