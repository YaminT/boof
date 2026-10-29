import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateDataRoot,
  MIGRATION_LOCK_FILE,
  MigrationError,
  withMigrationLock,
} from "./migrate.js";
import { ProjectSchema } from "./schema.js";
import { SettingsStore } from "./settings.js";
import { TaskStore } from "./store.js";
import { newTask, serializeTask } from "./task-file.js";
import type { Status } from "./schema.js";

let root: string;
let repo: string;

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const STATUS_DIRS: Record<Status, string> = {
  draft: "drafts",
  pending: "pending",
  running: "ongoing",
  action: "actions",
  done: "done",
  failed: "failed",
  archived: "archived",
};

const taskFile = (id: string, status: Status) =>
  serializeTask(
    newTask(
      {
        id,
        title: `Task ${id}`,
        status,
        priority: 50,
        skip: false,
        labels: [],
        command: null,
        attachments: [],
        questions: "none",
        runs: 1,
        completedRuns: 0,
        created: "2026-06-04T10:00:00.000Z",
        updated: "2026-06-04T10:00:00.000Z",
      },
      `prompt of ${id}`,
    ),
  );

const v1Settings = (workingDirectory: string) => ({
  runner: { enabled: true },
  workingDirectory,
  selectedSubdirectory: "packages/x",
  blockHours: 5,
  roles: {
    planner: { tool: "mock", model: "m" },
    developer: { tool: "mock", model: "m" },
    reviewer: { tool: "mock", model: "m" },
  },
  models: { mock: ["m"] },
  worktree: { onDone: "delete" },
});

/** A v1 data root: every status directory holds a task, plus usage.json and a command template. */
async function writeV1Root(workingDirectory: string): Promise<void> {
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(
    join(root, "commands", "secure.md"),
    "---\nid: secure\nname: Secure\n---\n\nBe safe.\n",
  );
  await writeFile(
    join(root, "settings.json"),
    JSON.stringify(v1Settings(workingDirectory), null, 2),
  );
  await writeFile(
    join(root, "usage.json"),
    JSON.stringify({ inputTokens: 10, outputTokens: 5, costUsd: 0.5, known: true }),
  );
  for (const [status, dir] of Object.entries(STATUS_DIRS) as [Status, string][]) {
    const id = `t-${status}`;
    if (status === "running") {
      await mkdir(join(root, "tasks", dir, id), { recursive: true });
      await writeFile(join(root, "tasks", dir, id, "task.md"), taskFile(id, status));
      await writeFile(join(root, "tasks", dir, id, "log.txt"), "log\n");
    } else {
      await mkdir(join(root, "tasks", dir), { recursive: true });
      await writeFile(join(root, "tasks", dir, `${id}.md`), taskFile(id, status));
    }
  }
  await mkdir(join(root, "tasks", "assets", "t-done"), { recursive: true });
  await writeFile(join(root, "tasks", "assets", "t-done", "a.png"), "png");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-migrate-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-migrate-repo-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("migrateDataRoot", () => {
  it("scaffolds v2 settings in an empty root: no projects, no default project", async () => {
    const r = await migrateDataRoot(root);
    expect(r.kind).toBe("fresh");
    const s = await new SettingsStore(root).load();
    expect(s.schemaVersion).toBe(2);
    expect(s.defaultProject).toBeNull();
    expect(await readdir(join(root, "projects"))).toEqual([]);
  });

  it("is a no-op on a v2 root", async () => {
    await migrateDataRoot(root);
    expect((await migrateDataRoot(root)).kind).toBe("current");
  });

  it("migrates a v1 root: tasks of every status, usage.json and commands/ end up where v2 expects them", async () => {
    await writeV1Root(repo);
    const r = await migrateDataRoot(root);
    expect(r.kind).toBe("migrated");

    const project = ProjectSchema.parse(
      JSON.parse(await readFile(join(root, "projects", "default", "project.json"), "utf8")),
    );
    expect(project).toMatchObject({
      id: "default",
      workingDirectory: repo,
      origin: { kind: "migration" },
      paused: false,
      archived: false,
    });
    expect(project.name).toBe(repo.split("/").pop());

    // Every task kept its status.
    const tasks = await new TaskStore(join(root, "projects", "default")).list();
    const byId = Object.fromEntries(tasks.map((t) => [t.frontmatter.id, t.frontmatter.status]));
    expect(byId).toEqual({
      "t-draft": "draft",
      "t-pending": "pending",
      "t-running": "running",
      "t-action": "action",
      "t-done": "done",
      "t-failed": "failed",
      "t-archived": "archived",
    });
    // Running task's working area and attachments moved with it.
    expect(
      await readFile(
        join(root, "projects", "default", "tasks", "ongoing", "t-running", "log.txt"),
        "utf8",
      ),
    ).toBe("log\n");
    expect(
      await exists(join(root, "projects", "default", "tasks", "assets", "t-done", "a.png")),
    ).toBe(true);
    expect(await exists(join(root, "tasks"))).toBe(false);

    // usage.json moved; commands/ stayed.
    expect(
      JSON.parse(await readFile(join(root, "projects", "default", "usage.json"), "utf8")),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
      known: true,
    });
    expect(await exists(join(root, "usage.json"))).toBe(false);
    expect(await exists(join(root, "commands", "secure.md"))).toBe(true);

    // Settings rewritten as v2 without the removed keys; the runner flag survives.
    const raw = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(raw.schemaVersion).toBe(2);
    expect(raw.defaultProject).toBe("default");
    expect(raw.runner).toEqual({ enabled: true, concurrency: 1 });
    expect(raw.worktree).toEqual({ onDone: "delete", onFailure: "keep" });
    for (const gone of ["workingDirectory", "selectedSubdirectory", "blockHours", "tokens"]) {
      expect(raw).not.toHaveProperty(gone);
    }

    // The log says what moved.
    const log = await readFile(join(root, "migration-v2.log"), "utf8");
    expect(log).toContain("moved tasks/ to projects/default/tasks/");
    expect(log).toContain("moved usage.json");
    expect(r.log.join("\n")).toContain("project.json");
  });

  it("is idempotent: a second run changes nothing", async () => {
    await writeV1Root(repo);
    await migrateDataRoot(root);
    const before = await readFile(join(root, "settings.json"), "utf8");
    const logBefore = await readFile(join(root, "migration-v2.log"), "utf8");
    expect((await migrateDataRoot(root)).kind).toBe("current");
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(before);
    expect(await readFile(join(root, "migration-v2.log"), "utf8")).toBe(logBefore);
    expect(await new TaskStore(join(root, "projects", "default")).list()).toHaveLength(7);
  });

  it("uses an empty working directory and the name 'default' when v1 never had one", async () => {
    await writeV1Root("");
    await migrateDataRoot(root);
    const project = JSON.parse(
      await readFile(join(root, "projects", "default", "project.json"), "utf8"),
    );
    expect(project.workingDirectory).toBe("");
    expect(project.name).toBe("default");
    expect((await new SettingsStore(root).load()).defaultProject).toBe("default");
  });

  it("refuses while a task is ongoing and the runner pid is alive, and changes nothing", async () => {
    await writeV1Root(repo);
    await writeFile(join(root, ".runner.pid"), "4242");
    await expect(migrateDataRoot(root, { isProcessAlive: () => true })).rejects.toBeInstanceOf(
      MigrationError,
    );
    await expect(migrateDataRoot(root, { isProcessAlive: () => true })).rejects.toThrow(
      /runner is alive/,
    );
    expect(await exists(join(root, "projects"))).toBe(false);
    expect(await exists(join(root, "tasks", "ongoing", "t-running"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8")).schemaVersion,
    ).toBeUndefined();
  });

  it("migrates when the pid is stale, or when nothing is ongoing", async () => {
    await writeV1Root(repo);
    await writeFile(join(root, ".runner.pid"), "4242");
    expect((await migrateDataRoot(root, { isProcessAlive: () => false })).kind).toBe("migrated");

    const other = await mkdtemp(join(tmpdir(), "boof-runner-migrate-b-"));
    try {
      await mkdir(join(other, "tasks", "ongoing"), { recursive: true });
      await writeFile(join(other, "settings.json"), JSON.stringify(v1Settings(repo)));
      await writeFile(join(other, ".runner.pid"), "4242");
      expect((await migrateDataRoot(other, { isProcessAlive: () => true })).kind).toBe("migrated");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("recovers from a crash after project.json and the tasks move, before settings.json was rewritten", async () => {
    await writeV1Root(repo);
    // Simulate the interrupted run: first steps done, settings.json still v1, usage.json not moved.
    const dest = join(root, "projects", "default");
    await mkdir(dest, { recursive: true });
    await writeFile(
      join(dest, "project.json"),
      JSON.stringify({
        id: "default",
        name: "kept-name",
        workingDirectory: repo,
        paused: false,
        archived: false,
        planWriteBack: true,
        labels: [],
        origin: { kind: "migration" },
        created: "2026-06-04T10:00:00.000Z",
        updated: "2026-06-04T10:00:00.000Z",
      }),
    );
    const { rename } = await import("node:fs/promises");
    await rename(join(root, "tasks"), join(dest, "tasks"));

    const r = await migrateDataRoot(root);
    expect(r.kind).toBe("migrated");
    expect(r.log.join("\n")).toContain("project.json already present");
    expect(r.log.join("\n")).toContain("tasks/ already moved");
    const project = JSON.parse(await readFile(join(dest, "project.json"), "utf8"));
    expect(project.name).toBe("kept-name"); // not overwritten
    expect(await exists(join(dest, "usage.json"))).toBe(true);
    expect(await exists(join(root, "usage.json"))).toBe(false);
    expect(await new TaskStore(dest).list()).toHaveLength(7);
    expect((await new SettingsStore(root).load()).schemaVersion).toBe(2);
  });

  it("recovers when both a v1 tasks/ and projects/default/tasks exist, keeping files already moved", async () => {
    await writeV1Root(repo);
    const dest = join(root, "projects", "default", "tasks");
    await mkdir(join(dest, "pending"), { recursive: true });
    await writeFile(join(dest, "pending", "t-pending.md"), taskFile("t-pending", "pending"));
    const r = await migrateDataRoot(root);
    expect(r.kind).toBe("migrated");
    const tasks = await new TaskStore(join(root, "projects", "default")).list();
    expect(tasks).toHaveLength(7);
    expect(r.log.join("\n")).toContain("kept conflicting v1 file in place");
  });

  it("refuses a data root written by a newer release", async () => {
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 3 }));
    await expect(migrateDataRoot(root)).rejects.toThrow(/newer/);
  });

  it("treats a v1 tasks/ tree without settings.json as v1 with no working directory", async () => {
    await mkdir(join(root, "tasks", "pending"), { recursive: true });
    await writeFile(join(root, "tasks", "pending", "t.md"), taskFile("t", "pending"));
    expect((await migrateDataRoot(root)).kind).toBe("migrated");
    expect(await new TaskStore(join(root, "projects", "default")).list()).toHaveLength(1);
  });
});

describe("migration lock", () => {
  it("two concurrent migrations of one v1 root run it once", async () => {
    await writeV1Root(repo);
    const [a, b] = await Promise.all([migrateDataRoot(root), migrateDataRoot(root)]);
    expect([a.kind, b.kind].sort()).toEqual(["current", "migrated"]);
    const log = await readFile(join(root, "migration-v2.log"), "utf8");
    expect(log.match(/migrating .* from v1 to v2/g)).toHaveLength(1);
    expect(await new TaskStore(join(root, "projects", "default")).list()).toHaveLength(7);
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(false);
  });

  it("takes over a lock left by a dead process", async () => {
    await writeV1Root(repo);
    await writeFile(join(root, MIGRATION_LOCK_FILE), "999999\n");
    const r = await migrateDataRoot(root, { isProcessAlive: () => false });
    expect(r.kind).toBe("migrated");
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(false);
  });

  it("waits for a lock held by a live process and gives up after lockTimeoutMs", async () => {
    await writeV1Root(repo);
    const before = await readFile(join(root, "settings.json"), "utf8");
    await writeFile(join(root, MIGRATION_LOCK_FILE), "4242\n");
    await expect(
      migrateDataRoot(root, { isProcessAlive: () => true, lockTimeoutMs: 200, lockPollMs: 20 }),
    ).rejects.toThrow(/pid 4242/);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(before);
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(true); // not ours to remove
  });

  it("removes the lock when the migration throws", async () => {
    await writeV1Root(repo);
    await writeFile(join(root, ".runner.pid"), "4242");
    await expect(migrateDataRoot(root, { isProcessAlive: () => true })).rejects.toThrow(
      MigrationError,
    );
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(false);
  });

  it("stale takeover admits one holder at a time", async () => {
    await mkdir(root, { recursive: true });
    for (let round = 0; round < 300; round++) {
      await writeFile(join(root, MIGRATION_LOCK_FILE), "999999\n");
      let inside = 0;
      let max = 0;
      // distinct pids simulate six processes (same-pid callers would queue in memory)
      await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) =>
          withMigrationLock(
            root,
            { pid: 5000 + n, isProcessAlive: (p) => p !== 999999, lockPollMs: 1 },
            async () => {
              inside++;
              max = Math.max(max, inside);
              await new Promise((r) => setTimeout(r, 1));
              inside--;
            },
          ),
        ),
      );
      expect(max).toBe(1);
      expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(false);
      expect(await exists(join(root, `${MIGRATION_LOCK_FILE}.takeover`))).toBe(false);
    }
  });

  it("takes over a stale lock that names our own pid", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, MIGRATION_LOCK_FILE), `${process.pid}\n`);
    expect(await withMigrationLock(root, { lockTimeoutMs: 500 }, async () => "ran")).toBe("ran");
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(false);
  });

  it("never takes the lock for a v2 root", async () => {
    await writeV1Root(repo);
    await migrateDataRoot(root);
    expect((await migrateDataRoot(root)).kind).toBe("current");
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(false);
    // would throw if the lock were needed
    await writeFile(join(root, MIGRATION_LOCK_FILE), "4242\n");
    expect(
      (await migrateDataRoot(root, { isProcessAlive: () => true, lockTimeoutMs: 50 })).kind,
    ).toBe("current");
  });

  it("waits on an empty holder value and takes over a dead complete pid", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, MIGRATION_LOCK_FILE), "12");
    await expect(
      withMigrationLock(
        root,
        { isProcessAlive: () => false, lockTimeoutMs: 100, lockPollMs: 10 },
        async () => 1,
      ),
    ).resolves.toBe(1); // "12" is a complete pid and dead
    await writeFile(join(root, MIGRATION_LOCK_FILE), "");
    await expect(
      withMigrationLock(
        root,
        { isProcessAlive: () => false, lockTimeoutMs: 100, lockPollMs: 10 },
        async () => 1,
      ),
    ).rejects.toThrow(MigrationError);
    expect(await exists(join(root, MIGRATION_LOCK_FILE))).toBe(true);
  });
});
