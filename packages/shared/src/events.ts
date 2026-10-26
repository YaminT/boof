/**
 * Structured events: one JSON line per state change, appended to `<projectDir>/events.jsonl`
 * (project events) or `<data>/events.jsonl` (global events). The file rotates monthly: the first
 * append of a new month renames the old file to `events-YYYY-MM.jsonl`. A position in the event
 * history is `{ month, offset }` (`YYYY-MM:<byte offset>`), stable across rotation.
 */
import { open, readdir, rename, stat } from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "./atomic.js";

const by = z.string().min(1);
const project = z.string().min(1);

export const TaskCreatedEventSchema = z.object({
  type: z.literal("task.created"),
  ts: z.string(),
  project,
  task: z.string(),
  status: z.string(),
  by,
});
export const TaskStatusEventSchema = z.object({
  type: z.literal("task.status"),
  ts: z.string(),
  project,
  task: z.string(),
  from: z.string(),
  to: z.string(),
  by,
  /** Why the runner moved the task on its own (e.g. recovery after a crash). */
  reason: z.string().optional(),
});
export const TaskQuestionsEventSchema = z.object({
  type: z.literal("task.questions"),
  ts: z.string(),
  project,
  task: z.string(),
  count: z.number().int().nonnegative(),
  by,
});
export const PlanUpdatedEventSchema = z.object({
  type: z.literal("plan.updated"),
  ts: z.string(),
  project,
  plan: z.string(),
  version: z.number().int(),
  by,
});
export const PlanSyncedEventSchema = z.object({
  type: z.literal("plan.synced"),
  ts: z.string(),
  project,
  plan: z.string(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  by,
});
export const RunnerEnabledEventSchema = z.object({
  type: z.literal("runner.enabled"),
  ts: z.string(),
  value: z.boolean(),
  by,
});
/** A day or task budget ran out; announced once per day and scope. */
export const RunnerBudgetExceededEventSchema = z.object({
  type: z.literal("runner.budget_exceeded"),
  ts: z.string(),
  /** `global`, `project:<id>`, `tool:<tool>` or `project:<id>/tool:<tool>`. */
  scope: z.string(),
  /** Local date (budget time zone) the budget belongs to. */
  date: z.string(),
  spentUsd: z.number(),
  limitUsd: z.number(),
  /** Set for project scopes. */
  project: z.string().optional(),
  by,
});

export const BoofEventSchema = z.discriminatedUnion("type", [
  TaskCreatedEventSchema,
  TaskStatusEventSchema,
  TaskQuestionsEventSchema,
  PlanUpdatedEventSchema,
  PlanSyncedEventSchema,
  RunnerEnabledEventSchema,
  RunnerBudgetExceededEventSchema,
]);
export type BoofEvent = z.infer<typeof BoofEventSchema>;
export type BoofEventType = BoofEvent["type"];
export const EVENT_TYPES = [
  "task.created",
  "task.status",
  "task.questions",
  "plan.updated",
  "plan.synced",
  "runner.enabled",
  "runner.budget_exceeded",
] as const satisfies readonly BoofEventType[];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event as the caller builds it; `ts` is added when it is written. */
export type NewEvent = DistributiveOmit<BoofEvent, "ts">;

const ACTIVE = "events.jsonl";
const ROTATED = /^events-(\d{4}-\d{2})\.jsonl$/;

/** A position in an events history: the file's month and a byte offset in it. */
export interface EventPos {
  month: string;
  offset: number;
}

export function encodePos(pos: EventPos): string {
  return `${pos.month}:${pos.offset}`;
}

export function parsePos(text: string): EventPos | null {
  const m = /^(\d{4}-\d{2}):(\d+)$/.exec(text);
  return m ? { month: m[1], offset: Number(m[2]) } : null;
}

const monthCache = new Map<string, string>();

/** Month (`YYYY-MM`) of the first event in the active file; null when there is none. */
async function activeMonth(dir: string): Promise<string | null> {
  const path = join(dir, ACTIVE);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    monthCache.delete(path);
    return null;
  }
  if (size === 0) return null;
  const cached = monthCache.get(path);
  if (cached) return cached;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(512, size));
    await fh.read(buf, 0, buf.length, 0);
    const m = /"ts":"(\d{4}-\d{2})/.exec(buf.toString("utf8"));
    if (!m) return null;
    monthCache.set(path, m[1]);
    return m[1];
  } finally {
    await fh.close();
  }
}

/**
 * Append one event. Never throws: an event that cannot be written must not fail the change
 * it describes (the error is logged).
 */
export async function appendEvent(
  dir: string,
  event: NewEvent,
  now: Date = new Date(),
): Promise<void> {
  try {
    const ts = now.toISOString();
    const path = join(dir, ACTIVE);
    const line = JSON.stringify({ ts, ...event }) + "\n";
    await withFileLock(path, async () => {
      await mkdir(dir, { recursive: true });
      const old = await activeMonth(dir);
      if (old && old !== ts.slice(0, 7)) {
        let target = join(dir, `events-${old}.jsonl`);
        for (
          let n = 1;
          await stat(target).then(
            () => true,
            () => false,
          );
          n += 1
        ) {
          target = join(dir, `events-${old}.${n}.jsonl`);
        }
        await rename(path, target);
        monthCache.delete(path);
      }
      await appendFile(path, line, "utf8");
    });
  } catch (err) {
    console.error("event append failed", err);
  }
}

interface EventFile {
  month: string;
  path: string;
}

async function eventFiles(dir: string): Promise<EventFile[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: EventFile[] = [];
  for (const name of names) {
    const m = ROTATED.exec(name);
    if (m) out.push({ month: m[1], path: join(dir, name) });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  const month = await activeMonth(dir);
  if (month) out.push({ month, path: join(dir, ACTIVE) });
  return out;
}

export interface StoredEvent {
  event: BoofEvent;
  /** Position just after this event: resume from it to get the events that follow. */
  pos: EventPos;
}

/** Position of the end of the history (what "from now on" means); null when there is none yet. */
export async function eventsEnd(dir: string): Promise<EventPos | null> {
  const files = await eventFiles(dir);
  const last = files[files.length - 1];
  if (!last) return null;
  return { month: last.month, offset: (await stat(last.path)).size };
}

/**
 * Events after `from` (null: from the very beginning), oldest first, at most `limit`.
 * Partial last lines (a write in flight) are left for the next call; bad lines are skipped.
 */
export async function readEvents(
  dir: string,
  from: EventPos | null,
  limit = 500,
): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for (const file of await eventFiles(dir)) {
    if (from && file.month < from.month) continue;
    let offset = from && file.month === from.month ? from.offset : 0;
    const size = (await stat(file.path).catch(() => null))?.size ?? 0;
    if (offset > size) offset = 0; // the file shrank (trimmed by hand): start over in it
    while (offset < size && out.length < limit) {
      const fh = await open(file.path, "r");
      let chunk: Buffer;
      try {
        const buf = Buffer.alloc(Math.min(1 << 20, size - offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        chunk = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) {
        if (chunk.length < 1 << 20) break; // incomplete line still being written
        offset += chunk.length; // a >1 MiB line is not an event: skip it
        continue;
      }
      let start = 0;
      while (start <= lastNl && out.length < limit) {
        const nl = chunk.indexOf(0x0a, start);
        const lineBytes = chunk.subarray(start, nl);
        start = nl + 1;
        offset += lineBytes.length + 1;
        try {
          const event = BoofEventSchema.parse(JSON.parse(lineBytes.toString("utf8")));
          out.push({ event, pos: { month: file.month, offset } });
        } catch {
          /* skip a corrupt line */
        }
      }
      if (start <= lastNl) break; // limit reached mid-chunk
    }
    if (out.length >= limit) break;
  }
  return out;
}
