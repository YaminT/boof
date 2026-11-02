import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { atomicWrite, withFileLock } from "./atomic.js";
import { appendEvent } from "./events.js";
import { assertKebabId } from "./paths.js";
import { uniqueKebabId } from "./ids.js";
import { EpicPatchSchema, EpicsFileSchema, type Epic, type EpicPatch } from "./schema.js";

export type EpicErrorCode = "not_found" | "exists" | "modified";

export class EpicError extends Error {
  constructor(
    public readonly code: EpicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EpicError";
  }
}

export interface CreateEpicInput {
  title: string;
  id?: string;
  description?: string;
  priority?: number;
}

/** `none` is the "no epic" value of the task filters, so it can never be an epic id. */
const RESERVED_IDS = ["none"];

/** Epics of a project: priority descending, then updated ascending, then id ascending. */
export function compareEpics(a: Epic, b: Epic): number {
  return (
    b.priority - a.priority ||
    (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const nowIso = () => new Date().toISOString();

/**
 * The epics of one project, in `<projectDir>/epics.json`. Every read-modify-write runs under the
 * file lock; the file is created by the first create. A project without it has no epics, but an
 * unreadable or invalid file throws (it is never read as empty, so a write cannot erase it).
 */
export class EpicStore {
  private readonly path: string;

  constructor(private readonly projectDir: string) {
    this.path = `${projectDir}/epics.json`;
  }

  private async read(): Promise<Epic[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return EpicsFileSchema.parse(JSON.parse(text)).epics;
  }

  private write(epics: Epic[]): Promise<void> {
    return atomicWrite(this.path, JSON.stringify({ epics }, null, 2) + "\n");
  }

  private announce(epic: string, change: "created" | "updated" | "deleted", by?: string) {
    return appendEvent(this.projectDir, {
      type: "epic.updated",
      project: basename(this.projectDir),
      epic,
      change,
      by: by ?? "runner",
    });
  }

  async list(opts: { includeArchived?: boolean } = {}): Promise<Epic[]> {
    const all = await this.read();
    return all.filter((e) => opts.includeArchived || !e.archived).sort(compareEpics);
  }

  async get(id: string): Promise<Epic | null> {
    return (await this.read()).find((e) => e.id === id) ?? null;
  }

  async require(id: string): Promise<Epic> {
    const epic = await this.get(id);
    if (!epic) throw new EpicError("not_found", `Epic not found: ${id}`);
    return epic;
  }

  async create(input: CreateEpicInput, opts: { by?: string } = {}): Promise<Epic> {
    const explicit = input.id === undefined ? undefined : assertKebabId(input.id);
    const epic = await withFileLock(this.path, async () => {
      const epics = await this.read();
      const taken = epics.map((e) => e.id);
      if (explicit !== undefined && (taken.includes(explicit) || RESERVED_IDS.includes(explicit))) {
        throw new EpicError("exists", `Epic id already exists or is reserved: ${explicit}`);
      }
      const now = nowIso();
      const created: Epic = {
        id: explicit ?? uniqueKebabId(input.title, [...taken, ...RESERVED_IDS]),
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        priority: input.priority ?? 0,
        archived: false,
        created: now,
        updated: now,
      };
      await this.write([...epics, created]);
      return created;
    });
    await this.announce(epic.id, "created", opts.by);
    return epic;
  }

  async update(
    id: string,
    patch: EpicPatch,
    opts: { by?: string; expectedUpdated?: string } = {},
  ): Promise<Epic> {
    const clean = EpicPatchSchema.parse(patch);
    const epic = await withFileLock(this.path, async () => {
      const epics = await this.read();
      const current = epics.find((e) => e.id === id);
      if (!current) throw new EpicError("not_found", `Epic not found: ${id}`);
      if (opts.expectedUpdated !== undefined && opts.expectedUpdated !== current.updated) {
        throw new EpicError("modified", `Epic ${id} was changed since it was read`);
      }
      const next: Epic = { ...current };
      for (const [key, value] of Object.entries(clean)) {
        if (value === undefined) continue;
        if (value === null) delete (next as Record<string, unknown>)[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      next.updated = nowIso();
      await this.write(epics.map((e) => (e.id === id ? next : e)));
      return next;
    });
    await this.announce(id, "updated", opts.by);
    return epic;
  }

  /**
   * Remove the record only; it does not touch the tasks that name it. Production code calls this
   * only from `removeEpic` (hierarchy.ts), which detaches or refuses first.
   */
  async remove(id: string, opts: { by?: string } = {}): Promise<void> {
    await withFileLock(this.path, async () => {
      const epics = await this.read();
      if (!epics.some((e) => e.id === id))
        throw new EpicError("not_found", `Epic not found: ${id}`);
      await this.write(epics.filter((e) => e.id !== id));
    });
    await this.announce(id, "deleted", opts.by);
  }
}
