/**
 * Budget enforcement support: the durable daily spend ledger and the evaluation of limits
 * against it. The runner writes the ledger as steps finish; the API only reads it.
 *
 * Layout: `<data>/usage/daily/YYYY-MM-DD.json` (everything: totals, per project, per tool) and
 * `<project>/usage/daily/YYYY-MM-DD.json` (that project: total and per tool). The date is the
 * calendar day in the budget time zone when the cost was recorded.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, withFileLock } from "./atomic.js";
import { projectPaths } from "./paths.js";
import type { BudgetSettings, Project, Settings, TokenUsage } from "./schema.js";

export interface DailyLedger {
  date: string;
  timezone: string;
  /** Known cost recorded that day. Steps with unknown usage count as 0 here. */
  costUsd: number;
  /** Steps whose usage was unknown (counted as 0 cost). */
  unknownSteps: number;
  /** Cost per tool id. */
  tools: Record<string, number>;
  /** Cost per project id (global ledger only). */
  projects?: Record<string, number>;
  /** Scopes already announced with a `runner.budget_exceeded` event (global ledger only). */
  notified?: string[];
}

/** The server's local IANA zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The time zone budgets use: `budget.timezone`, else the server's local zone. */
export function budgetTimeZone(settings: Pick<Settings, "budget">): string {
  return settings.budget?.timezone ?? localTimeZone();
}

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function dayKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The instant the next day starts in `timeZone` (found by bisection, so DST-safe). */
export function nextDayStart(now: Date, timeZone: string): Date {
  const today = dayKey(now, timeZone);
  let lo = now.getTime();
  let hi = lo + 26 * 3600_000; // no day is longer than 25 h
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(new Date(mid), timeZone) === today) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

export function dailyLedgerPath(dir: string, date: string): string {
  return join(dir, "usage", "daily", `${date}.json`);
}

function emptyLedger(date: string, timezone: string): DailyLedger {
  return { date, timezone, costUsd: 0, unknownSteps: 0, tools: {} };
}

export async function readDailyLedger(
  dir: string,
  date: string,
  timezone: string,
): Promise<DailyLedger> {
  try {
    const raw = JSON.parse(await readFile(dailyLedgerPath(dir, date), "utf8")) as DailyLedger;
    return { ...emptyLedger(date, timezone), ...raw };
  } catch {
    return emptyLedger(date, timezone);
  }
}

async function modifyLedger(
  dir: string,
  date: string,
  timezone: string,
  fn: (l: DailyLedger) => void,
): Promise<void> {
  const path = dailyLedgerPath(dir, date);
  await withFileLock(path, async () => {
    const ledger = await readDailyLedger(dir, date, timezone);
    fn(ledger);
    await atomicWrite(path, JSON.stringify(ledger, null, 2) + "\n");
  });
}

export interface RecordSpendInput {
  /** Data root; omit to skip the global ledger. */
  dataRoot?: string;
  projectId: string;
  /** Project directory (`projects/<id>`); defaults to the one under `dataRoot`. */
  projectDir?: string;
  tool: string;
  usage: Pick<TokenUsage, "costUsd" | "known">;
  timezone: string;
  now?: Date;
}

/** Add one step's cost to the global and project daily ledgers (atomic writes). */
export async function recordSpend(input: RecordSpendInput): Promise<void> {
  const now = input.now ?? new Date();
  const date = dayKey(now, input.timezone);
  const known = input.usage.known;
  const cost = known && Number.isFinite(input.usage.costUsd) ? input.usage.costUsd : 0;
  const apply = (l: DailyLedger) => {
    l.costUsd += cost;
    if (!known) l.unknownSteps += 1;
    l.tools[input.tool] = (l.tools[input.tool] ?? 0) + cost;
  };
  const projectDir =
    input.projectDir ?? (input.dataRoot ? projectPaths(input.dataRoot, input.projectId).dir : null);
  if (projectDir) await modifyLedger(projectDir, date, input.timezone, apply);
  if (input.dataRoot) {
    await modifyLedger(input.dataRoot, date, input.timezone, (l) => {
      apply(l);
      l.projects = {
        ...l.projects,
        [input.projectId]: (l.projects?.[input.projectId] ?? 0) + cost,
      };
    });
  }
}

/** Mark `scope` as announced for `date`; true when this call was the first to do so. */
export async function markBudgetNotified(
  dataRoot: string,
  date: string,
  timezone: string,
  scope: string,
): Promise<boolean> {
  let first = false;
  await modifyLedger(dataRoot, date, timezone, (l) => {
    const seen = l.notified ?? [];
    if (!seen.includes(scope)) {
      first = true;
      l.notified = [...seen, scope];
    }
  });
  return first;
}

/** One limit and what has been spent against it today. */
export interface BudgetScope {
  /** `global`, `project:<id>`, `tool:<tool>` or `project:<id>/tool:<tool>`. */
  scope: string;
  spentUsd: number;
  /** Null when the scope has no limit. */
  limitUsd: number | null;
  /** Null when unlimited; never negative. */
  remainingUsd: number | null;
  /** Spent is at or over the limit (no budget left). */
  exceeded: boolean;
}

export interface BudgetStatus {
  /** Local date the figures are for, in `timezone`. */
  date: string;
  timezone: string;
  /** When today's budgets reset (ISO). */
  resetsAt: string;
  /** Global limits as configured (`onExceed` defaulted). */
  limits: BudgetSettings;
  /** Steps today whose usage was unknown (counted as 0). */
  unknownSteps: number;
  scopes: BudgetScope[];
  /** The scopes with `exceeded: true`. */
  exceeded: BudgetScope[];
  /** Per project: the effective per-task limit and exceed behaviour. */
  projects: { id: string; perTaskUsd: number | null; onExceed: "pause" | "fail" }[];
}

function scopeOf(
  scope: string,
  spentUsd: number,
  limitUsd: number | null | undefined,
): BudgetScope {
  const limit = limitUsd ?? null;
  return {
    scope,
    spentUsd,
    limitUsd: limit,
    remainingUsd: limit === null ? null : Math.max(0, limit - spentUsd),
    exceeded: limit !== null && spentUsd >= limit,
  };
}

/** The per-task limit and exceed behaviour of a project (project override over global). */
export function projectTaskBudget(
  settings: Pick<Settings, "budget">,
  project: Pick<Project, "budget"> | undefined,
): { perTaskUsd: number | null; onExceed: "pause" | "fail" } {
  return {
    perTaskUsd: project?.budget?.perTaskUsd ?? settings.budget?.perTaskUsd ?? null,
    onExceed: project?.budget?.onExceed ?? settings.budget?.onExceed ?? "pause",
  };
}

/** Evaluate today's spend against the limits for `projects`. */
export async function evaluateBudget(
  dataRoot: string,
  settings: Pick<Settings, "budget">,
  projects: Pick<Project, "id" | "budget">[],
  now: Date = new Date(),
): Promise<BudgetStatus> {
  const timezone = budgetTimeZone(settings);
  const date = dayKey(now, timezone);
  const budget = settings.budget;
  const global = await readDailyLedger(dataRoot, date, timezone);
  const scopes: BudgetScope[] = [scopeOf("global", global.costUsd, budget?.perDayUsd)];
  const tools = new Set([
    ...Object.keys(global.tools),
    ...Object.keys(budget?.perToolDayUsd ?? {}),
  ]);
  for (const tool of [...tools].sort()) {
    scopes.push(scopeOf(`tool:${tool}`, global.tools[tool] ?? 0, budget?.perToolDayUsd?.[tool]));
  }
  for (const project of projects) {
    const ledger = await readDailyLedger(projectPaths(dataRoot, project.id).dir, date, timezone);
    const limit = project.budget?.perProjectDayUsd ?? budget?.perProjectDayUsd;
    scopes.push(scopeOf(`project:${project.id}`, ledger.costUsd, limit));
    const own = project.budget?.perToolDayUsd ?? {};
    const projectTools = new Set([...Object.keys(ledger.tools), ...Object.keys(own)]);
    for (const tool of [...projectTools].sort()) {
      scopes.push(
        scopeOf(`project:${project.id}/tool:${tool}`, ledger.tools[tool] ?? 0, own[tool]),
      );
    }
  }
  return {
    date,
    timezone,
    resetsAt: nextDayStart(now, timezone).toISOString(),
    limits: { onExceed: "pause", ...budget },
    unknownSteps: global.unknownSteps,
    scopes,
    exceeded: scopes.filter((s) => s.exceeded),
    projects: projects.map((p) => ({ id: p.id, ...projectTaskBudget(settings, p) })),
  };
}

/**
 * The exhausted day scopes that stop work of `projectId` using `tools`: the global budget, the
 * project's, and each tool's global and per-project budget. Empty means the work may run.
 */
export function blockingScopes(
  status: BudgetStatus,
  projectId: string,
  tools: Iterable<string>,
): BudgetScope[] {
  const wanted = new Set(["global", `project:${projectId}`]);
  for (const t of tools) {
    wanted.add(`tool:${t}`);
    wanted.add(`project:${projectId}/tool:${t}`);
  }
  return status.exceeded.filter((s) => wanted.has(s.scope));
}

/** `budget exceeded: <scope> <spent>/<limit> USD`, the failure reason a task records. */
export function budgetExceededMessage(scope: string, spentUsd: number, limitUsd: number): string {
  return `budget exceeded: ${scope} ${spentUsd.toFixed(4)}/${limitUsd} USD`;
}
