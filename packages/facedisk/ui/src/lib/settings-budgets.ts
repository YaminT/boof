import type { ProjectPatch, SettingsPatch } from "@boof/heart/schema";
import { parseToolLimits, parseUsd, toolLimitsText } from "./form-numbers.js";
import { changedKeys, type PageModel, type PageValues } from "./settings-draft.js";

export interface BudgetsGlobal {
  perTask: string;
  perDay: string;
  perProjectDay: string;
  perTool: string;
  onExceed: "pause" | "fail";
  timezone: string;
}

/** This project's own limits; an empty string (or `""` for onExceed) means "same as all projects". */
export interface BudgetsOwn {
  perTask: string;
  /** The project's own day limit (`perProjectDayUsd`). */
  perDay: string;
  perTool: string;
  onExceed: "" | "pause" | "fail";
}

export type BudgetsValues = PageValues<BudgetsGlobal, BudgetsOwn>;

const str = (n: number | undefined) => (n === undefined ? "" : String(n));

function validZone(tz: string): boolean {
  if (!tz.trim()) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

const usdSentence = (label: string) =>
  `${label}: use an amount in USD above 0, or leave it empty for no limit.`;
const toolSentence = (prefix: string) =>
  `${prefix}Per day, each tool: write one tool=USD per line, for example codex=5.`;

/** Settings › Budgets: limits for all projects and this project's own, and the time zone. */
export const budgetsPage: PageModel<BudgetsValues> = {
  values: (s, p) => ({
    global: {
      perTask: str(s.budget?.perTaskUsd),
      perDay: str(s.budget?.perDayUsd),
      perProjectDay: str(s.budget?.perProjectDayUsd),
      perTool: toolLimitsText(s.budget?.perToolDayUsd),
      onExceed: s.budget?.onExceed ?? "pause",
      timezone: s.budget?.timezone ?? "",
    },
    project: {
      perTask: str(p.budget?.perTaskUsd),
      perDay: str(p.budget?.perProjectDayUsd),
      perTool: toolLimitsText(p.budget?.perToolDayUsd),
      onExceed: p.budget?.onExceed ?? "",
    },
  }),

  problems: (v) => {
    const out: string[] = [];
    const g = v.global;
    const o = v.project;
    if (!parseUsd(g.perTask).ok) out.push(usdSentence("Per task"));
    if (!parseUsd(g.perDay).ok) out.push(usdSentence("Per day, all work"));
    if (!parseUsd(g.perProjectDay).ok) out.push(usdSentence("Per day, each project"));
    if (!parseToolLimits(g.perTool).ok) out.push(toolSentence(""));
    if (!validZone(g.timezone)) out.push("Time zone: use an IANA name such as Europe/Berlin.");
    if (!parseUsd(o.perTask).ok) out.push(usdSentence("This project, per task"));
    if (!parseUsd(o.perDay).ok) out.push(usdSentence("This project, per day"));
    if (!parseToolLimits(o.perTool).ok) out.push(toolSentence("This project, "));
    return out;
  },

  patches: (form, base, latest) => {
    const g = form.global;
    const settings: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value === undefined) delete budget[key];
      else budget[key] = value;
    };
    const budget: Record<string, unknown> = { ...latest.settings.budget };
    const gc = new Set(changedKeys(g, base.global));
    if (gc.has("perTask")) set("perTaskUsd", okValue(parseUsd(g.perTask)));
    if (gc.has("perDay")) set("perDayUsd", okValue(parseUsd(g.perDay)));
    if (gc.has("perProjectDay")) set("perProjectDayUsd", okValue(parseUsd(g.perProjectDay)));
    if (gc.has("perTool")) set("perToolDayUsd", okValue(parseToolLimits(g.perTool)));
    if (gc.has("onExceed")) set("onExceed", g.onExceed);
    if (gc.has("timezone")) set("timezone", g.timezone.trim() || undefined);
    const result: { settings?: SettingsPatch; project?: ProjectPatch } = {};
    if (gc.size > 0) {
      Object.assign(settings, { budget });
      result.settings = settings as SettingsPatch;
    }

    const o = form.project;
    const pc = new Set(changedKeys(o, base.project));
    if (pc.size > 0) {
      const own: Record<string, unknown> = { ...latest.project.budget };
      const setOwn = (key: string, value: unknown) => {
        if (value === undefined) delete own[key];
        else own[key] = value;
      };
      if (pc.has("perTask")) setOwn("perTaskUsd", okValue(parseUsd(o.perTask)));
      if (pc.has("perDay")) setOwn("perProjectDayUsd", okValue(parseUsd(o.perDay)));
      if (pc.has("perTool")) setOwn("perToolDayUsd", okValue(parseToolLimits(o.perTool)));
      if (pc.has("onExceed")) setOwn("onExceed", o.onExceed || undefined);
      result.project = {
        budget: Object.keys(own).length > 0 ? (own as ProjectPatch["budget"]) : null,
      };
    }
    return result;
  },
};

function okValue<T>(p: { ok: true; value: T | undefined } | { ok: false }): T | undefined {
  return p.ok ? p.value : undefined;
}
