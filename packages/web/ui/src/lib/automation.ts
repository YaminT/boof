import { ApiError } from "../api.js";
import { errorMessage } from "./act.js";

/** The id a command template gets from its name (the server derives the same). */
export function commandIdFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
] as const;

/** Event types and patterns from a text field; empty means every event. */
export function parseEvents(text: string): string[] {
  const events = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  return events.length > 0 ? events : ["*"];
}

// The server's pattern for an event type or `prefix.*`.
const EVENT = /^(\*|[a-z]+(\.[a-z]+|\.\*)?)$/;

export function webhookFormProblems(v: {
  url: string;
  events: string;
  projects: "*" | string[];
}): string[] {
  const out: string[] = [];
  if (!/^https?:\/\/\S+/i.test(v.url.trim()))
    out.push("Enter a URL that starts with http:// or https://.");
  if (!parseEvents(v.events).every((e) => EVENT.test(e)))
    out.push("Use event types such as task.status or patterns such as plan.*.");
  if (v.projects !== "*" && v.projects.length === 0)
    out.push("Choose at least one project, or send events from every project.");
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
