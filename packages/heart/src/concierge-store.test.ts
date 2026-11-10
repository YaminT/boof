import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLYING_GRACE_MS,
  CHANGE_TTL_MS,
  ConciergeStore,
  MAX_PENDING_PER_CONVERSATION,
  type PendingChange,
} from "./concierge-store.js";
import { conciergeDir } from "./paths.js";

const PID = "demo";
const OWNER = "user-1";
const IDLE = 30 * 60_000;

let root: string;

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boof-concierge-store-"));
  await chmod(dir, 0o700);
  return dir;
}

function change(
  id: string,
  createdAtMs: number,
  status: PendingChange["status"] = "pending",
): PendingChange {
  return {
    id,
    op: "tasks.delete",
    input: { projectId: PID, taskId: "fix-readme" },
    title: "Delete task",
    details: [],
    destructive: true,
    reason: "confirm",
    guard: { kind: "task", id: "fix-readme", stamp: "2026-11-06T00:00:00.000Z" },
    status,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + CHANGE_TTL_MS).toISOString(),
  };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("ConciergeStore", () => {
  it("creates a conversation, reuses it within idleMs, and starts a new one after", async () => {
    root = await scratch();
    let now = Date.parse("2026-11-06T12:00:00.000Z");
    const store = new ConciergeStore(root, () => now);

    const first = await store.current(PID, OWNER, IDLE);
    expect(first).toMatchObject({
      projectId: PID,
      owner: OWNER,
      sessionId: null,
      baseline: null,
      spentUsd: 0,
      unknownTurns: 0,
      messages: 0,
      changes: [],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    expect(first.id).toMatch(/^cnv-[0-9a-f]{8}$/);

    now += IDLE - 1;
    const again = await store.current(PID, OWNER, IDLE);
    expect(again.id).toBe(first.id);

    now += 2;
    const next = await store.current(PID, OWNER, IDLE);
    expect(next.id).not.toBe(first.id);
    expect(await store.get(PID, first.id)).not.toBeNull();
  });

  it("reset ends the live conversation", async () => {
    root = await scratch();
    const store = new ConciergeStore(root, () => Date.parse("2026-11-06T12:00:00.000Z"));
    const first = await store.current(PID, OWNER, IDLE);
    await store.reset(PID, OWNER);
    const next = await store.current(PID, OWNER, IDLE);
    expect(next.id).not.toBe(first.id);
    expect(await store.get(PID, first.id)).toMatchObject({ id: first.id, owner: OWNER });
  });

  it("does not find another owner's change", async () => {
    root = await scratch();
    const now = Date.parse("2026-11-06T12:00:00.000Z");
    const store = new ConciergeStore(root, () => now);
    const conv = await store.current(PID, OWNER, IDLE);
    const pending = change("chg-aabbccdd", now);
    await store.update(PID, conv.id, (c) => {
      c.changes.push(pending);
    });

    expect(await store.findChange(PID, "someone-else", pending.id)).toBeNull();
    const found = await store.findChange(PID, OWNER, pending.id);
    expect(found?.change.id).toBe(pending.id);
    expect(found?.conversation.id).toBe(conv.id);
  });

  it("expires a change at 15 minutes", async () => {
    expect(CHANGE_TTL_MS).toBe(15 * 60_000);
    expect(MAX_PENDING_PER_CONVERSATION).toBe(20);
    root = await scratch();
    let now = Date.parse("2026-11-06T12:00:00.000Z");
    const store = new ConciergeStore(root, () => now);
    const conv = await store.current(PID, OWNER, IDLE);
    const pending = change("chg-11223344", now);
    await store.update(PID, conv.id, (c) => {
      c.changes.push(pending);
    });

    now += CHANGE_TTL_MS - 1;
    expect((await store.findChange(PID, OWNER, pending.id))?.change.status).toBe("pending");

    now += 1;
    const found = await store.findChange(PID, OWNER, pending.id);
    expect(found?.change.status).toBe("expired");
    expect((await store.get(PID, conv.id))?.changes[0]?.status).toBe("expired");

    const live = await store.current(PID, OWNER, IDLE);
    expect(live.id).toBe(conv.id);
    expect(live.changes[0]?.status).toBe("expired");
  });

  it("recovers stale applying changes and leaves fresh ones alone", async () => {
    root = await scratch();
    let now = Date.parse("2026-11-06T12:00:00.000Z");
    const store = new ConciergeStore(root, () => now);
    const conv = await store.current(PID, OWNER, IDLE);
    const stale = change("chg-aabbccdd", now, "applying");
    const fresh = change("chg-bbccddee", now + CHANGE_TTL_MS, "applying");
    await store.update(PID, conv.id, (c) => {
      c.changes.push(stale, fresh);
    });

    now += CHANGE_TTL_MS + APPLYING_GRACE_MS;
    const recovered = await store.get(PID, conv.id);
    expect(recovered?.changes[0]).toMatchObject({ status: "failed", error: "interrupted" });
    expect(recovered?.changes[1]?.status).toBe("applying");

    const newer = change("chg-ccddeeaa", now, "applying");
    await store.update(PID, conv.id, (c) => c.changes.push(newer));
    expect((await store.findChange(PID, OWNER, newer.id))?.change.status).toBe("applying");
  });

  it("writes conversation files as 0600 in a 0700 directory", async () => {
    root = await scratch();
    const store = new ConciergeStore(root, () => Date.parse("2026-11-06T12:00:00.000Z"));
    const conv = await store.current(PID, OWNER, IDLE);
    const file = join(conciergeDir(root, PID), "conversations", `${conv.id}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(conciergeDir(root, PID), "conversations"))).mode & 0o777).toBe(0o700);
  });

  it("keeps both edits when two updates run together", async () => {
    root = await scratch();
    const store = new ConciergeStore(root, () => Date.parse("2026-11-06T12:00:00.000Z"));
    const conv = await store.current(PID, OWNER, IDLE);
    await Promise.all([
      store.update(PID, conv.id, (c) => {
        c.messages += 1;
        c.spentUsd += 0.1;
      }),
      store.update(PID, conv.id, (c) => {
        c.unknownTurns += 1;
        c.spentUsd += 0.2;
      }),
    ]);
    const got = await store.get(PID, conv.id);
    expect(got?.messages).toBe(1);
    expect(got?.unknownTurns).toBe(1);
    expect(got?.spentUsd).toBeCloseTo(0.3);
  });

  it("replaces a corrupt conversation without quoting the file", async () => {
    root = await scratch();
    const store = new ConciergeStore(root, () => Date.parse("2026-11-06T12:00:00.000Z"));
    const conv = await store.current(PID, OWNER, IDLE);
    const secret = "SECRET_FILE_BODY_do_not_log_zzzz";
    const file = join(conciergeDir(root, PID), "conversations", `${conv.id}.json`);
    await mkdir(join(conciergeDir(root, PID), "conversations"), { recursive: true });
    await writeFile(file, `not json ${secret} {{{`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const next = await store.current(PID, OWNER, IDLE);
      expect(next.id).not.toBe(conv.id);
      expect(next.messages).toBe(0);
      const logged = spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).not.toContain(secret);
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("prune removes conversations older than the cutoff and leaves the live one", async () => {
    root = await scratch();
    let now = Date.parse("2026-11-06T12:00:00.000Z");
    const store = new ConciergeStore(root, () => now);
    const old = await store.current(PID, OWNER, IDLE);
    now += IDLE;
    const live = await store.current(PID, OWNER, IDLE);
    expect(live.id).not.toBe(old.id);
    now += 1;

    expect(await store.prune(PID, IDLE)).toBe(1);
    expect(await store.get(PID, old.id)).toBeNull();
    expect((await store.get(PID, live.id))?.id).toBe(live.id);
    expect((await store.current(PID, OWNER, IDLE)).id).toBe(live.id);
  });

  it("expires a due change under the update lock before the edit", async () => {
    root = await scratch();
    let now = Date.parse("2026-11-06T12:00:00.000Z");
    const store = new ConciergeStore(root, () => now);
    const conv = await store.current(PID, OWNER, IDLE);
    const pending = change("chg-99887766", now);
    await store.update(PID, conv.id, (c) => {
      c.changes.push(pending);
    });
    now += CHANGE_TTL_MS;
    await store.update(PID, conv.id, (c) => {
      expect(c.changes[0]?.status).toBe("expired");
      c.messages += 1;
    });
    const got = await store.get(PID, conv.id);
    expect(got?.changes[0]?.status).toBe("expired");
    expect(got?.messages).toBe(1);
  });

  it("rejects an invalid conversation without claiming it is missing", async () => {
    root = await scratch();
    const store = new ConciergeStore(root, () => Date.parse("2026-11-06T12:00:00.000Z"));
    const conv = await store.current(PID, OWNER, IDLE);
    await expect(store.update(PID, "cnv-00000000", () => {})).rejects.toThrow(
      "Conversation not found: cnv-00000000",
    );
    const before = await store.get(PID, conv.id);
    const rejected = store.update(PID, conv.id, (c) => {
      c.spentUsd = -1;
    });
    await expect(rejected).rejects.toThrow(`Invalid concierge conversation: ${conv.id}`);
    await expect(rejected).rejects.not.toThrow(/not found/);
    const after = await store.get(PID, conv.id);
    expect(after?.spentUsd).toBe(0);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("logs an unreadable conversation once across scans", async () => {
    root = await scratch();
    const store = new ConciergeStore(root, () => Date.parse("2026-11-06T12:00:00.000Z"));
    const conv = await store.current(PID, OWNER, IDLE);
    const file = join(conciergeDir(root, PID), "conversations", `${conv.id}.json`);
    await writeFile(file, "not json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await store.findChange(PID, OWNER, "chg-aabbccdd")).toBeNull();
      expect(await store.findChange(PID, OWNER, "chg-aabbccdd")).toBeNull();
      const logs = spy.mock.calls.map((args) => args.map(String).join(" "));
      expect(logs.filter((line) => line.includes(conv.id))).toHaveLength(1);
      expect(logs.join("\n")).not.toContain("not json");
    } finally {
      spy.mockRestore();
    }
  });
});
