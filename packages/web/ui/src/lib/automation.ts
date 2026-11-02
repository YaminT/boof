import { toKebabId } from "@boof-runner/shared/ids";
import { ApiError } from "../api.js";
import type { Whoami } from "../api-types.js";
import { errorMessage } from "./act.js";

/** The id a command template gets from its name: the server's rule, with its "command" fallback. */
export function commandIdFor(name: string): string {
  return toKebabId(name) || "command";
}

export const TEMPLATE_RULE =
  "Only a trusted key without a project restriction can change templates.";

/** Templates are global: only the local principal or a trusted, unrestricted key may change them. */
export function canChangeTemplates(w: Whoami | null): boolean {
  if (!w || w.principal.kind === "local") return true;
  return w.principal.trust === "trusted" && w.principal.projects === "*";
}

/** What stops a template from being saved. `editingId` is the template being edited, if any. */
export function templateFormProblems(
  name: string,
  existingIds: readonly string[],
  editingId: string | null,
): string[] {
  const out: string[] = [];
  if (!name.trim()) out.push("Name the template.");
  else {
    const id = commandIdFor(name);
    if (id !== editingId && existingIds.includes(id)) out.push("A template with this id exists.");
  }
  return out;
}

export const EVENT_HINTS = [
  "*",
  "task.*",
  "plan.*",
  "runner.*",
  "epic.*",
  "task.status",
  "task.questions",
  "plan.synced",
  "runner.budget_exceeded",
] as const;

/** Event types and patterns from a text field; empty means every event. */
export function parseEvents(text: string): string[] {
  const events = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  return events.length > 0 ? events : ["*"];
}

// The server's pattern for an event type or `prefix.*`.
const EVENT = /^(\*|[a-z]+(_[a-z]+)*(\.([a-z]+(_[a-z]+)*|\*))?)$/;

export function webhookFormProblems(
  v: {
    url: string;
    events: string;
    projects: "*" | string[];
  },
  /** The projects the caller is limited to, or null when it reaches every project. */
  reach: string[] | null = null,
): string[] {
  const out: string[] = [];
  if (!/^https?:\/\/\S+/i.test(v.url.trim()))
    out.push("Enter a URL that starts with http:// or https://.");
  if (!parseEvents(v.events).every((e) => EVENT.test(e)))
    out.push("Use event types such as task.status or patterns such as plan.*.");
  if (v.projects !== "*" && v.projects.length === 0)
    out.push("Choose at least one project, or send events from every project.");
  if (reach) {
    if (v.projects === "*") out.push("Your own key cannot send events from every project.");
    else {
      const outside = v.projects.filter((p) => !reach.includes(p));
      if (outside.length > 0) out.push(`Your own key cannot reach: ${outside.join(", ")}.`);
    }
  }
  return out;
}

/** One line per validation detail of a 400, else the error's message. */
export function inputErrorLines(err: unknown): string[] {
  if (err instanceof ApiError && err.status === 400 && Array.isArray(err.details)) {
    return (err.details as { path?: string; message: string }[]).map((d) =>
      d.path ? `${d.path}: ${d.message}` : d.message,
    );
  }
  return [errorMessage(err)];
}
