import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditLine, auditOperation, pruneAudit } from "./audit-log.js";
import { defaultSettings, SettingsStore } from "./settings.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-audit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const lines = async () => {
  const dir = join(root, "audit");
  const files = await readdir(dir).catch(() => []);
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8"))))
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe("audit log", () => {
  it("appends one JSON line to the day's file", async () => {
    await appendAuditLine(root, { ts: "2026-03-01T10:00:00.000Z", principal: "a" });
    await appendAuditLine(root, { ts: "2026-03-01T11:00:00.000Z", principal: "b" });
    expect(await readdir(join(root, "audit"))).toEqual(["2026-03-01.jsonl"]);
    expect((await lines()).map((l) => l.principal)).toEqual(["a", "b"]);
  });

  it("auditOperation records who, what, where and outcome, with the surface, and no values", async () => {
    await new SettingsStore(root).save(defaultSettings());
    await auditOperation(root, {
      principal: { id: "local-mcp", kind: "client" },
      action: "mcp:boof_create_task",
      via: "stdio-mcp",
      project: "demo",
      ok: false,
      code: "forbidden_trust",
      ms: 12,
      at: Date.parse("2026-03-01T10:00:00Z"),
    });
    expect(await lines()).toEqual([
      {
        ts: "2026-03-01T10:00:00.000Z",
        principal: "local-mcp",
        kind: "client",
        action: "mcp:boof_create_task",
        via: "stdio-mcp",
        project: "demo",
        outcome: "error",
        error: "forbidden_trust",
        ms: 12,
      },
    ]);
  });

  it("auditOperation accepts via concierge", async () => {
    await new SettingsStore(root).save(defaultSettings());
    await auditOperation(root, {
      principal: { id: "local", kind: "local" },
      action: "concierge.ask",
      via: "concierge",
      project: "demo",
      ok: true,
      ms: 4,
      at: Date.parse("2026-03-01T10:00:00Z"),
    });
    expect(await lines()).toEqual([
      {
        ts: "2026-03-01T10:00:00.000Z",
        principal: "local",
        kind: "local",
        action: "concierge.ask",
        via: "concierge",
        project: "demo",
        outcome: "ok",
        ms: 4,
      },
    ]);
  });

  it("writes nothing when security.audit.enabled is false", async () => {
    const settings = defaultSettings();
    await new SettingsStore(root).save({
      ...settings,
      security: { ...settings.security, audit: { enabled: false, retentionDays: 90 } },
    });
    await auditOperation(root, {
      principal: { id: "local", kind: "local" },
      action: "cli:tasks.list",
      via: "cli",
      ok: true,
      ms: 1,
    });
    expect(await lines()).toEqual([]);
  });

  it("never throws: a broken audit directory must not fail the operation", async () => {
    await writeFile(join(root, "audit"), "a file where the directory should be");
    await expect(
      auditOperation(root, {
        principal: { id: "x", kind: "local" },
        action: "a",
        via: "cli",
        ok: true,
        ms: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("prunes daily files older than retentionDays and keeps others", async () => {
    for (const d of ["2025-01-01", "2026-02-27"])
      await appendAuditLine(root, { ts: `${d}T00:00:00.000Z` });
    await writeFile(join(root, "audit", "notes.txt"), "keep");
    expect(await pruneAudit(root, 7, Date.parse("2026-03-01T00:00:00Z"))).toEqual([
      "2025-01-01.jsonl",
    ]);
    expect((await readdir(join(root, "audit"))).sort()).toEqual(["2026-02-27.jsonl", "notes.txt"]);
  });

  it("auditOperation writes extra fields after the core keys and never overrides them", async () => {
    await new SettingsStore(root).save(defaultSettings());
    await auditOperation(root, {
      principal: { id: "runner", kind: "runner" },
      action: "n8n:trigger",
      via: "runner",
      ok: true,
      ms: 3,
      at: Date.parse("2026-03-01T10:00:00Z"),
      extra: {
        host: "n8n.local:5678",
        httpStatus: 200,
        ts: "evil",
        outcome: "evil",
        action: "evil",
      },
    });
    const [line] = await lines();
    expect(line).toMatchObject({
      ts: "2026-03-01T10:00:00.000Z",
      principal: "runner",
      action: "n8n:trigger",
      via: "runner",
      outcome: "ok",
      host: "n8n.local:5678",
      httpStatus: 200,
    });
    expect(Object.keys(line!).slice(-2)).toEqual(["host", "httpStatus"]);
  });
});
