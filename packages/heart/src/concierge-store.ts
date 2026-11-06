import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "./atomic.js";
import { conciergeDir } from "./paths.js";
import { withProcessLock } from "./process-lock.js";
import { TokenUsageSchema, type TokenUsage } from "./schema.js";

export const MAX_PENDING_PER_CONVERSATION = 20;
export const CHANGE_TTL_MS = 15 * 60_000;
export const APPLYING_GRACE_MS = 10 * 60_000;

export function isInterruptedApply(change: PendingChange, now: number): boolean {
  if (change.status !== "applying") return false;
  const expiresAt = Date.parse(change.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt + APPLYING_GRACE_MS <= now;
}

const CONV_ID = /^cnv-[0-9a-f]{8}$/;

export interface PendingChange {
  /** `chg-` plus 8 hex characters. */
  id: string;
  /** Registry name. */
  op: string;
  /** Validated input, including `projectId`. */
  input: Record<string, unknown>;
  /** One line, from the server preview. */
  title: string;
  /** At most 8 lines. */
  details: string[];
  destructive: boolean;
  /** Why confirming can only fail; set by the preview. */
  blocked?: string;
  reason: "confirm" | "needs-approval";
  /** Task `updated`, plan `version`, or epic `updated`. */
  guard: { kind: "task" | "plan" | "epic"; id: string; stamp: string } | null;
  status: "pending" | "applying" | "applied" | "discarded" | "expired" | "failed";
  createdAt: string;
  /** `createdAt` plus 15 minutes. */
  expiresAt: string;
  error?: string;
}

export interface ConciergeConversation {
  id: string;
  projectId: string;
  /** Principal id of the user. */
  owner: string;
  sessionId: string | null;
  baseline: TokenUsage | null;
  spentUsd: number;
  unknownTurns: number;
  messages: number;
  createdAt: string;
  updatedAt: string;
  changes: PendingChange[];
}

const GuardSchema = z.object({
  kind: z.enum(["task", "plan", "epic"]),
  id: z.string(),
  stamp: z.string(),
});

const ChangeSchema = z.object({
  id: z.string(),
  op: z.string(),
  input: z.record(z.string(), z.unknown()),
  title: z.string(),
  details: z.array(z.string()),
  destructive: z.boolean(),
  blocked: z.string().optional(),
  reason: z.enum(["confirm", "needs-approval"]),
  guard: GuardSchema.nullable(),
  status: z.enum(["pending", "applying", "applied", "discarded", "expired", "failed"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  error: z.string().optional(),
});

const ConversationSchema = z.object({
  id: z.string().regex(CONV_ID),
  projectId: z.string(),
  owner: z.string(),
  sessionId: z.string().nullable(),
  baseline: TokenUsageSchema.nullable(),
  spentUsd: z.number().nonnegative(),
  unknownTurns: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  changes: z.array(ChangeSchema),
});

const LiveSchema = z.object({
  owners: z.record(z.string(), z.string()),
});

type ReadConversation = ConciergeConversation | null | "corrupt";

/**
 * Conversations for one data root, as JSON under `<conciergeDir>/conversations/`.
 * Every read-modify-write holds `<conciergeDir>/.lock`, so a CLI ask and the server
 * cannot drop each other's pending changes.
 */
export class ConciergeStore {
  /** Corrupt ids already reported, so a scan does not log the same file on every pass. */
  private readonly reportedUnreadable = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The owner's live conversation (updated within `idleMs`), or a new one. */
  async current(projectId: string, owner: string, idleMs: number): Promise<ConciergeConversation> {
    return this.locked(projectId, async () => {
      const index = await this.readIndex(projectId);
      const id = index.owners[owner];
      if (id && CONV_ID.test(id)) {
        const existing = await this.readConversation(projectId, id);
        if (existing && existing !== "corrupt" && existing.owner === owner) {
          const age = this.now() - Date.parse(existing.updatedAt);
          if (age >= 0 && age < idleMs) {
            if (this.expire(existing)) await this.writeConversation(projectId, existing);
            return existing;
          }
        }
      }
      const created = this.blank(projectId, owner, await this.freshId(projectId));
      await this.writeConversation(projectId, created);
      index.owners[owner] = created.id;
      await this.writeIndex(projectId, index);
      return created;
    });
  }

  async get(projectId: string, conversationId: string): Promise<ConciergeConversation | null> {
    if (!CONV_ID.test(conversationId)) return null;
    return this.locked(projectId, async () => {
      const found = await this.readConversation(projectId, conversationId);
      if (found === "corrupt" || !found) return null;
      if (this.expire(found)) await this.writeConversation(projectId, found);
      return found;
    });
  }

  async update(
    projectId: string,
    conversationId: string,
    fn: (conversation: ConciergeConversation) => void,
  ): Promise<ConciergeConversation> {
    if (!CONV_ID.test(conversationId)) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return this.locked(projectId, async () => {
      const current = await this.readConversation(projectId, conversationId);
      if (!current || current === "corrupt") {
        throw new Error(`Conversation not found: ${conversationId}`);
      }
      // Expire under the lock before the edit. A change can cross expiresAt between
      // findChange and this write; saving it must not leave that change pending.
      this.expire(current);
      fn(current);
      current.updatedAt = this.iso();
      const parsed = ConversationSchema.safeParse(current);
      if (!parsed.success) {
        throw new Error(`Invalid concierge conversation: ${conversationId}`);
      }
      await this.writeConversation(projectId, parsed.data);
      return parsed.data;
    });
  }

  /**
   * The change, including one that just expired. Null when it belongs to another owner
   * or does not exist. Pending changes past `expiresAt` are stored as `expired`.
   */
  async findChange(
    projectId: string,
    owner: string,
    changeId: string,
  ): Promise<{ conversation: ConciergeConversation; change: PendingChange } | null> {
    return this.locked(projectId, async () => {
      for (const id of await this.conversationIds(projectId)) {
        const conv = await this.readConversation(projectId, id);
        if (!conv || conv === "corrupt" || conv.owner !== owner) continue;
        if (this.expire(conv)) await this.writeConversation(projectId, conv);
        const change = conv.changes.find((item) => item.id === changeId);
        if (change) return { conversation: conv, change };
      }
      return null;
    });
  }

  /** Ends the live conversation. The file stays, so `get` can still read it. */
  async reset(projectId: string, owner: string): Promise<void> {
    await this.locked(projectId, async () => {
      const index = await this.readIndex(projectId);
      if (index.owners[owner] === undefined) return;
      delete index.owners[owner];
      await this.writeIndex(projectId, index);
    });
  }

  /** Removes conversation files whose `updatedAt` is older than `olderThanMs`. */
  async prune(projectId: string, olderThanMs: number): Promise<number> {
    return this.locked(projectId, async () => {
      const index = await this.readIndex(projectId);
      let removed = 0;
      for (const id of await this.conversationIds(projectId)) {
        const conv = await this.readConversation(projectId, id);
        const age = await this.ageOf(projectId, id, conv);
        if (age === null || age <= olderThanMs) continue;
        await rm(this.conversationPath(projectId, id), { force: true });
        for (const [key, live] of Object.entries(index.owners)) {
          if (live === id) delete index.owners[key];
        }
        removed += 1;
      }
      if (removed > 0) await this.writeIndex(projectId, index);
      return removed;
    });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private blank(projectId: string, owner: string, id: string): ConciergeConversation {
    const at = this.iso();
    return {
      id,
      projectId,
      owner,
      sessionId: null,
      baseline: null,
      spentUsd: 0,
      unknownTurns: 0,
      messages: 0,
      createdAt: at,
      updatedAt: at,
      changes: [],
    };
  }

  /** Expire due proposals and recover applies past their expiry grace. */
  private expire(conversation: ConciergeConversation): boolean {
    const now = this.now();
    let changed = false;
    for (const change of conversation.changes) {
      if (change.status === "pending") {
        const at = Date.parse(change.expiresAt);
        if (Number.isNaN(at) || at > now) continue;
        change.status = "expired";
        changed = true;
      } else if (change.status === "applying") {
        if (!isInterruptedApply(change, now)) continue;
        change.status = "failed";
        change.error = "interrupted";
        changed = true;
      }
    }
    return changed;
  }

  private async ageOf(
    projectId: string,
    id: string,
    conv: ReadConversation,
  ): Promise<number | null> {
    if (conv && conv !== "corrupt") {
      const at = Date.parse(conv.updatedAt);
      if (Number.isNaN(at)) return null;
      return this.now() - at;
    }
    if (conv !== "corrupt") return null;
    try {
      const info = await stat(this.conversationPath(projectId, id));
      return this.now() - info.mtimeMs;
    } catch {
      return null;
    }
  }

  private async freshId(projectId: string): Promise<string> {
    for (;;) {
      const id = `cnv-${randomBytes(4).toString("hex")}`;
      const found = await this.readConversation(projectId, id);
      if (found === null) return id;
    }
  }

  private dir(projectId: string): string {
    return conciergeDir(this.root, projectId);
  }

  private conversationDir(projectId: string): string {
    return join(this.dir(projectId), "conversations");
  }

  private conversationPath(projectId: string, id: string): string {
    return join(this.conversationDir(projectId), `${id}.json`);
  }

  private indexPath(projectId: string): string {
    return join(this.dir(projectId), "live.json");
  }

  private async locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    return withProcessLock(
      join(dir, ".lock"),
      {},
      fn,
      (holder, path) =>
        new Error(
          `Another boof process is updating the assistant conversation (pid ${holder}); try again in a moment, or remove ${path} if no boof process is running`,
        ),
    );
  }

  private async conversationIds(projectId: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.conversationDir(projectId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((name) => name.endsWith(".json") && CONV_ID.test(name.slice(0, -".json".length)))
      .map((name) => name.slice(0, -".json".length));
  }

  private reportUnreadable(projectId: string, id: string): void {
    const key = `${projectId}\0${id}`;
    if (this.reportedUnreadable.has(key)) return;
    this.reportedUnreadable.add(key);
    console.error(`Unreadable concierge conversation ${id}`);
  }

  private async readConversation(projectId: string, id: string): Promise<ReadConversation> {
    if (!CONV_ID.test(id)) return null;
    let text: string;
    try {
      text = await readFile(this.conversationPath(projectId, id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.reportUnreadable(projectId, id);
      return "corrupt";
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.reportUnreadable(projectId, id);
      return "corrupt";
    }
    const parsed = ConversationSchema.safeParse(raw);
    if (!parsed.success) {
      this.reportUnreadable(projectId, id);
      return "corrupt";
    }
    return parsed.data;
  }

  private async writeConversation(
    projectId: string,
    conversation: ConciergeConversation,
  ): Promise<void> {
    const dir = this.conversationDir(projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = this.conversationPath(projectId, conversation.id);
    await atomicWrite(path, JSON.stringify(conversation, null, 2) + "\n", 0o600);
    await chmod(path, 0o600);
  }

  private async readIndex(projectId: string): Promise<{ owners: Record<string, string> }> {
    let text: string;
    try {
      text = await readFile(this.indexPath(projectId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { owners: {} };
      this.reportUnreadable(projectId, "index");
      return { owners: {} };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.reportUnreadable(projectId, "index");
      return { owners: {} };
    }
    const parsed = LiveSchema.safeParse(raw);
    if (!parsed.success) {
      this.reportUnreadable(projectId, "index");
      return { owners: {} };
    }
    return parsed.data;
  }

  private async writeIndex(
    projectId: string,
    index: { owners: Record<string, string> },
  ): Promise<void> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = this.indexPath(projectId);
    await atomicWrite(path, JSON.stringify(index, null, 2) + "\n", 0o600);
    await chmod(path, 0o600);
  }
}
