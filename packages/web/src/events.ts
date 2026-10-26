import {
  authorizeProject,
  eventsEnd,
  encodePos,
  parsePos,
  projectPaths,
  readEvents,
  type BoofEvent,
  type EventPos,
  type Principal,
} from "@boof-runner/shared";
import type { TaskService } from "@boof-runner/api";

/** Scope name of the global events file (`<data>/events.jsonl`); projects use their id. */
export const GLOBAL_SCOPE = "_";

/** A position per event scope (project id or `_`). Scopes that are absent start at the beginning. */
export type FeedCursor = Record<string, EventPos>;

export function encodeFeedCursor(cursor: FeedCursor): string {
  const flat = Object.fromEntries(Object.entries(cursor).map(([k, v]) => [k, encodePos(v)]));
  return Buffer.from(JSON.stringify(flat)).toString("base64url");
}

/** Decode a cursor; null when it is not one this server issued. */
export function decodeFeedCursor(text: string): FeedCursor | null {
  try {
    const flat: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (!flat || typeof flat !== "object" || Array.isArray(flat)) return null;
    const out: FeedCursor = {};
    for (const [k, v] of Object.entries(flat)) {
      const pos = typeof v === "string" ? parsePos(v) : null;
      if (!pos) return null;
      out[k] = pos;
    }
    return out;
  } catch {
    return null;
  }
}

export interface FeedEvent {
  event: BoofEvent;
  /** Cursor after this event: send it as the SSE `id`, resume with it as `since`. */
  cursor: string;
}

function scopeDir(root: string, scope: string): string {
  return scope === GLOBAL_SCOPE ? root : projectPaths(root, scope).dir;
}

/** The scopes (projects and the global file) `principal` may read, or just `project`. */
export async function readableScopes(
  service: TaskService,
  principal: Principal,
  project?: string,
): Promise<string[]> {
  if (project) return [project];
  const projects = await service.projects.list({ includeArchived: true });
  return [
    GLOBAL_SCOPE,
    ...projects.filter((p) => authorizeProject(principal, p.id)).map((p) => p.id),
  ];
}

/** The cursor that means "from now on" for `scopes`. */
export async function liveCursor(root: string, scopes: string[]): Promise<FeedCursor> {
  const cursor: FeedCursor = {};
  for (const scope of scopes) {
    const end = await eventsEnd(scopeDir(root, scope));
    if (end) cursor[scope] = end;
  }
  return cursor;
}

/**
 * Up to `limit` events after `cursor` across `scopes`, oldest first (by timestamp), each with
 * the cursor that follows it. `cursor` is not modified.
 */
export async function readFeed(
  root: string,
  scopes: string[],
  cursor: FeedCursor,
  limit = 200,
): Promise<FeedEvent[]> {
  const merged: { scope: string; event: BoofEvent; pos: EventPos }[] = [];
  for (const scope of scopes) {
    for (const e of await readEvents(scopeDir(root, scope), cursor[scope] ?? null, limit)) {
      merged.push({ scope, event: e.event, pos: e.pos });
    }
  }
  merged.sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.scope.localeCompare(b.scope));
  const running: FeedCursor = { ...cursor };
  const out: FeedEvent[] = [];
  for (const m of merged.slice(0, limit)) {
    running[m.scope] = m.pos;
    out.push({ event: m.event, cursor: encodeFeedCursor(running) });
  }
  return out;
}
