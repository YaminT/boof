import type {
  Project,
  ProjectPatch,
  RoleAssignment,
  Settings,
  SettingsPatch,
} from "@boof-runner/shared/schema";
import { parseCount } from "./form-numbers.js";
import { changedKeys, sameValue, type PageModel, type PageValues } from "./settings-draft.js";

export type RoleName = "planner" | "developer" | "observer" | "reviewer";
export const ROLES: readonly RoleName[] = ["planner", "developer", "observer", "reviewer"];

type OnDone = "keep-branch" | "keep" | "delete";
type OnFailure = "keep" | "delete";

export interface AgentsGlobal {
  concurrency: string;
  roles: Settings["roles"];
  models: Record<string, string[]>;
  gate: boolean;
  maxFixRounds: string;
  transient: string;
  onDone: OnDone;
  onFailure: OnFailure;
}

/** This project's overrides; `null` means "same as all projects". */
export interface AgentsOwn {
  roles: Partial<Record<RoleName, RoleAssignment>>;
  gate: boolean | null;
  maxFixRounds: string | null;
  transient: string | null;
  onDone: OnDone | null;
  onFailure: OnFailure | null;
}

export type AgentsValues = PageValues<AgentsGlobal, AgentsOwn>;

const unique = (v: string[]) => [...new Set(v.map((x) => x.trim()).filter(Boolean))];

/** Every tool's models, plus the model each assigned role uses. */
export function withRoleModels(
  models: Record<string, string[]>,
  roles: Settings["roles"],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [tool, list] of Object.entries(models)) out[tool] = unique(list);
  for (const role of ROLES) {
    const a = roles[role];
    if (a) out[a.tool] = unique([...(out[a.tool] ?? []), a.model]);
  }
  return out;
}

/** The number a count field holds; undefined when empty or not valid (problems() reports that). */
const countValue = (t: string): number | undefined => {
  const r = parseCount(t, 0);
  return r.ok ? r.value : undefined;
};

const num = (n: number | undefined) => (n === undefined ? null : String(n));

export const agentsPage: PageModel<AgentsValues> = {
  values: (s, p) => ({
    global: {
      concurrency: String(s.runner.concurrency),
      roles: s.roles,
      models: withRoleModels(s.models, s.roles),
      gate: s.review?.gate ?? true,
      maxFixRounds: String(s.review?.maxFixRounds ?? 2),
      transient: String(s.retries?.transient ?? 2),
      onDone: s.worktree?.onDone ?? "keep-branch",
      onFailure: s.worktree?.onFailure ?? "keep",
    },
    project: {
      roles: p.roles ?? {},
      gate: p.review?.gate ?? null,
      maxFixRounds: num(p.review?.maxFixRounds),
      transient: num(p.retries?.transient),
      onDone: p.worktree?.onDone ?? null,
      onFailure: p.worktree?.onFailure ?? null,
    },
  }),

  problems: (v) => {
    const out: string[] = [];
    const c = parseCount(v.global.concurrency, 1);
    if (!c.ok || c.value === undefined) out.push("Run at least 1 task at a time.");
    const fr = parseCount(v.global.maxFixRounds, 0);
    if (!fr.ok || fr.value === undefined)
      out.push("Use a whole number of 0 or more for fix rounds.");
    const tr = parseCount(v.global.transient, 0);
    if (!tr.ok || tr.value === undefined) out.push("Use a whole number of 0 or more for retries.");
    if (v.project.maxFixRounds !== null && !parseCount(v.project.maxFixRounds, 0).ok)
      out.push("Fix rounds for this project: use a whole number of 0 or more.");
    if (v.project.transient !== null && !parseCount(v.project.transient, 0).ok)
      out.push("Retries for this project: use a whole number of 0 or more.");
    return out;
  },

  patches: (form, base, latest) => {
    const g = form.global;
    const settings: SettingsPatch = {};
    const gChanged = new Set(changedKeys(g, base.global));
    if (gChanged.has("concurrency")) {
      const c = parseCount(g.concurrency, 1);
      if (c.ok && c.value !== undefined) settings.runner = { concurrency: c.value };
    }
    if (gChanged.has("roles")) {
      // The roles that changed, on top of the latest copy; the observer may be removed.
      const roles: Record<string, RoleAssignment | undefined> = { ...latest.settings.roles };
      for (const r of ROLES) {
        if (sameValue(g.roles[r], base.global.roles[r])) continue;
        if (g.roles[r]) roles[r] = g.roles[r];
        else delete roles[r];
      }
      settings.roles = roles as Settings["roles"];
    }
    if (gChanged.has("models")) {
      const merged: Record<string, string[]> = { ...latest.settings.models };
      // Only the tools whose list changed, on top of the latest map.
      for (const [tool, list] of Object.entries(g.models)) {
        if (sameValue(list, base.global.models[tool])) continue;
        merged[tool] = unique([...(merged[tool] ?? []), ...list]);
      }
      settings.models = merged;
    }
    const review: Record<string, unknown> = {};
    if (gChanged.has("gate")) review.gate = g.gate;
    if (gChanged.has("maxFixRounds")) review.maxFixRounds = countValue(g.maxFixRounds);
    if (Object.keys(review).length > 0)
      settings.review = { ...latest.settings.review, ...review } as SettingsPatch["review"];
    if (gChanged.has("transient"))
      settings.retries = {
        ...latest.settings.retries,
        transient: countValue(g.transient),
      } as SettingsPatch["retries"];
    const wt: Record<string, unknown> = {};
    if (gChanged.has("onDone")) wt.onDone = g.onDone;
    if (gChanged.has("onFailure")) wt.onFailure = g.onFailure;
    if (Object.keys(wt).length > 0)
      settings.worktree = { ...latest.settings.worktree, ...wt } as SettingsPatch["worktree"];

    const o = form.project;
    const project: ProjectPatch = {};
    const pChanged = new Set(changedKeys(o, base.project));
    if (pChanged.has("roles")) {
      const roles: Record<string, RoleAssignment | undefined> = { ...latest.project.roles };
      for (const r of ROLES) {
        if (sameValue(o.roles[r], base.project.roles[r])) continue;
        if (o.roles[r]) roles[r] = o.roles[r];
        else delete roles[r];
      }
      project.roles = Object.keys(roles).length > 0 ? (roles as ProjectPatch["roles"]) : null;
    }
    /** An override object: the latest keys, the changed ones set or removed; empty becomes null. */
    const group = <T extends object>(
      current: T | undefined,
      changes: Record<string, unknown>,
    ): T | null => {
      const out: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === undefined) delete out[k];
        else out[k] = v;
      }
      return Object.keys(out).length > 0 ? (out as T) : null;
    };
    const countOrNull = (t: string | null) => (t === null ? null : countValue(t));
    const rv: Record<string, unknown> = {};
    if (pChanged.has("gate")) rv.gate = o.gate;
    if (pChanged.has("maxFixRounds")) rv.maxFixRounds = countOrNull(o.maxFixRounds);
    if (Object.keys(rv).length > 0) project.review = group(latest.project.review, rv);
    if (pChanged.has("transient"))
      project.retries = group(latest.project.retries, { transient: countOrNull(o.transient) });
    const wv: Record<string, unknown> = {};
    if (pChanged.has("onDone")) wv.onDone = o.onDone;
    if (pChanged.has("onFailure")) wv.onFailure = o.onFailure;
    if (Object.keys(wv).length > 0) project.worktree = group(latest.project.worktree, wv);

    return {
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(Object.keys(project).length > 0 ? { project } : {}),
    };
  },
};

/** "checked just now" or "checked N min ago" for a health check time; null when there is none. */
export function checkedAgo(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const mins = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return null;
  return mins < 1 ? "checked just now" : `checked ${mins} min ago`;
}

/** Role or project usage as shown on a model chip: "planner", or "alpha: developer". */
export function usageLabel(usage: string): string {
  const m = /^project:([^:]+):(.+)$/.exec(usage);
  return m ? `${m[1]}: ${m[2]}` : usage;
}

export type { Project };
