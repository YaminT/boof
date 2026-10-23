import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataRootPaths } from "./paths.js";
import {
  effectiveSettings,
  resolveObserver,
  resolveRole,
  resolveWorktreeRoot,
  retrySettings,
  reviewSettings,
  SettingsStore,
  securitySettings,
  worktreeSettings,
} from "./settings.js";
import { defaultSettings } from "./settings.js";
import { newTask, parseTask, serializeTask } from "./task-file.js";
import { SettingsPatchSchema, type Project, type TaskFrontmatter } from "./schema.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-settings-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "t1",
  title: "T1",
  status: "pending",
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
  ...over,
});

describe("settings compatibility", () => {
  it("loads an old settings.json without observer or review", async () => {
    const old = {
      schemaVersion: 2,
      runner: { enabled: false },
      roles: {
        planner: { tool: "mock", model: "m" },
        developer: { tool: "mock", model: "m" },
        reviewer: { tool: "mock", model: "m" },
      },
      models: { mock: ["m"] },
    };
    const path = dataRootPaths(root).settings;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(old), "utf8");
    const s = await new SettingsStore(root).load();
    expect(s.roles.observer).toBeUndefined();
    expect(reviewSettings(s)).toEqual({ gate: true, maxFixRounds: 2, maxInlineDiffBytes: 120000 });
    expect(resolveObserver(s, newTask(fm()))).toBeUndefined();
    expect(worktreeSettings(s)).toEqual({ onDone: "keep-branch", onFailure: "keep" });
    expect(retrySettings(s)).toEqual({
      transient: 2,
      backoffMs: [30000, 120000],
      idleTimeoutMs: 1200000,
    });
    expect(s.runner.concurrency).toBe(1);
    expect(s.defaultProject).toBeNull();
    expect(resolveWorktreeRoot(worktreeSettings(s), "/tmp/x")).toBe(
      "/tmp/x/.boof-runner-worktrees",
    );
  });

  it("round-trips worktree and retry settings", async () => {
    const store = new SettingsStore(root);
    const s = defaultSettings();
    s.worktree = { root: "/tmp/wt", onDone: "delete", onFailure: "delete" };
    s.retries = { transient: 5, backoffMs: [1], idleTimeoutMs: 10 };
    await store.save(s);
    const loaded = await store.load();
    expect(worktreeSettings(loaded)).toEqual(s.worktree);
    expect(retrySettings(loaded)).toEqual(s.retries);
  });

  it("round-trips the task base ref", () => {
    const task = newTask(fm({ base: "main" }), "p");
    expect(parseTask(serializeTask(task)).frontmatter.base).toBe("main");
    expect(parseTask(serializeTask(newTask(fm(), "p"))).frontmatter.base).toBeUndefined();
  });

  it("resolves the worktree root: unset, relative, ~, absolute", () => {
    const wd = "/tmp/x";
    expect(resolveWorktreeRoot({}, wd)).toBe("/tmp/x/.boof-runner-worktrees");
    expect(resolveWorktreeRoot({ root: "../wt" }, wd)).toBe("/tmp/wt");
    expect(resolveWorktreeRoot({ root: "~/wts/a" }, wd)).toBe(join(homedir(), "wts", "a"));
    expect(resolveWorktreeRoot({ root: "~" }, wd)).toBe(homedir());
    expect(resolveWorktreeRoot({ root: "/abs/wt" }, wd)).toBe("/abs/wt");
  });

  it("round-trips observer and review settings", async () => {
    const store = new SettingsStore(root);
    const s = defaultSettings();
    s.roles.observer = { tool: "mock", model: "mock-default" };
    s.review = { gate: false, maxFixRounds: 5, maxInlineDiffBytes: 10 };
    await store.save(s);
    const loaded = await store.load();
    expect(loaded.roles.observer).toEqual({ tool: "mock", model: "mock-default" });
    expect(reviewSettings(loaded)).toEqual({
      gate: false,
      maxFixRounds: 5,
      maxInlineDiffBytes: 10,
    });
  });

  it("per-task tools.observer wins over the global observer", () => {
    const s = defaultSettings();
    s.roles.observer = { tool: "mock", model: "global" };
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "task" } } }));
    expect(resolveObserver(s, task)?.model).toBe("task");
    expect(resolveObserver(s, newTask(fm()))?.model).toBe("global");
    expect(resolveRole(s, task, "reviewer")).toEqual(s.roles.reviewer);
  });

  it("resolveRole honours observer: task, then global, then undefined", () => {
    const s = defaultSettings();
    expect(resolveRole(s, newTask(fm()), "observer")).toBeUndefined();
    s.roles.observer = { tool: "mock", model: "global" };
    expect(resolveRole(s, newTask(fm()), "observer")?.model).toBe("global");
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "task" } } }));
    expect(resolveRole(s, task, "observer")?.model).toBe("task");
  });
});

describe("legacy settings.json compatibility", () => {
  it("loads a file without review/worktree/retries/security and does not write defaults", async () => {
    const legacy = { ...defaultSettings() };
    const paths = dataRootPaths(root);
    await mkdir(dirname(paths.settings), { recursive: true });
    await writeFile(paths.settings, JSON.stringify(legacy, null, 2) + "\n");
    const store = new SettingsStore(root);
    const loaded = await store.load();
    expect(loaded).toEqual(legacy);
    expect(Object.keys(loaded)).not.toContain("security");
    const saved = await store.save(loaded);
    expect(saved).toEqual(legacy);
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toEqual(legacy);
  });

  it("fills nested security defaults from an empty or partial object", () => {
    const s = defaultSettings();
    expect(securitySettings(s)).toEqual({
      allowedHosts: [],
      auth: { mode: "local-trust" },
      allowedProjectRoots: [],
      externalTasksRequireApproval: true,
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30 },
      audit: { enabled: true, retentionDays: 90 },
    });
    expect(
      securitySettings({ ...s, security: { rateLimit: { perMinute: 5 } } as never }).rateLimit,
    ).toEqual({ perMinute: 5, attachmentsPerMinute: 30 });
  });
});

describe("v2 settings store", () => {
  it("scaffolds v2 defaults: schemaVersion 2, no default project, concurrency 1, no workingDirectory", async () => {
    const s = await new SettingsStore(root).load();
    expect(s.schemaVersion).toBe(2);
    expect(s.defaultProject).toBeNull();
    expect(s.runner).toEqual({ enabled: false, concurrency: 1 });
    expect(Object.keys(s)).not.toContain("workingDirectory");
  });

  it("refuses a v1 file with a pointer to the migration", async () => {
    const path = dataRootPaths(root).settings;
    await writeFile(path, JSON.stringify({ runner: { enabled: false }, workingDirectory: "/x" }));
    await expect(new SettingsStore(root).load()).rejects.toThrow(/v1 settings file/);
  });

  it("update merges runner per key, so enabling the runner keeps the concurrency", async () => {
    const store = new SettingsStore(root);
    await store.update({ runner: { concurrency: 3 } });
    const s = await store.update({ runner: { enabled: true } });
    expect(s.runner).toEqual({ enabled: true, concurrency: 3 });
  });

  it("SettingsPatchSchema rejects workingDirectory and accepts defaultProject", () => {
    expect(SettingsPatchSchema.safeParse({ workingDirectory: "/x" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ defaultProject: "app" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ defaultProject: null }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ defaultProject: "Not Kebab" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ runner: { enabled: true } }).success).toBe(true);
  });
});

describe("effectiveSettings", () => {
  const project = (over: Partial<Project> = {}): Project => ({
    id: "app",
    name: "app",
    workingDirectory: "/repos/app",
    paused: false,
    archived: false,
    planWriteBack: true,
    labels: [],
    origin: { kind: "cli" },
    created: "2026-06-04T10:00:00.000Z",
    updated: "2026-06-04T10:00:00.000Z",
    ...over,
  });

  it("adds the project's working directory and leaves global settings alone without overrides", () => {
    const g = defaultSettings();
    const e = effectiveSettings(g, project());
    expect(e.workingDirectory).toBe("/repos/app");
    expect(e.roles).toEqual(g.roles);
    expect(e.runner).toEqual(g.runner);
  });

  it("merges roles, review, worktree and retries per key with the project winning", () => {
    const g = defaultSettings();
    g.review = { gate: true, maxFixRounds: 2, maxInlineDiffBytes: 100 };
    g.worktree = { root: "/global/wt", onDone: "keep-branch", onFailure: "keep" };
    g.retries = { transient: 2, backoffMs: [1], idleTimeoutMs: 5 };
    const e = effectiveSettings(
      g,
      project({
        roles: { developer: { tool: "mock", model: "p-dev" } },
        review: { maxFixRounds: 7 },
        worktree: { root: "/project/wt" },
        retries: { transient: 0 },
      }),
    );
    expect(e.roles.developer).toEqual({ tool: "mock", model: "p-dev" });
    expect(e.roles.planner).toEqual(g.roles.planner);
    expect(reviewSettings(e)).toEqual({ gate: true, maxFixRounds: 7, maxInlineDiffBytes: 100 });
    expect(worktreeSettings(e)).toEqual({
      root: "/project/wt",
      onDone: "keep-branch",
      onFailure: "keep",
    });
    expect(retrySettings(e).transient).toBe(0);
    expect(retrySettings(e).backoffMs).toEqual([1]);
    expect(resolveWorktreeRoot(worktreeSettings(e), e.workingDirectory)).toBe("/project/wt");
    // The global settings object is not mutated.
    expect(g.roles.developer.model).toBe("gpt-5.5");
  });

  it("falls back to <workingDirectory>/.boof-runner-worktrees per project", () => {
    const g = defaultSettings();
    const e = effectiveSettings(g, project({ worktree: { onDone: "delete" } }));
    expect(resolveWorktreeRoot(worktreeSettings(e), e.workingDirectory)).toBe(
      "/repos/app/.boof-runner-worktrees",
    );
    expect(worktreeSettings(e).onDone).toBe("delete");
  });

  it("applies a per-task override on top of the project's role", () => {
    const e = effectiveSettings(
      defaultSettings(),
      project({ roles: { reviewer: { tool: "mock", model: "p-rev" } } }),
    );
    expect(resolveRole(e, newTask(fm()), "reviewer").model).toBe("p-rev");
    const task = newTask(fm({ tools: { reviewer: { tool: "mock", model: "t-rev" } } }));
    expect(resolveRole(e, task, "reviewer").model).toBe("t-rev");
  });
});
