import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths } from "./paths.js";
import {
  resolveObserver,
  resolveRole,
  resolveWorktreeRoot,
  retrySettings,
  reviewSettings,
  SettingsStore,
  worktreeSettings,
} from "./settings.js";
import { defaultSettings } from "./settings.js";
import { newTask, parseTask, serializeTask } from "./task-file.js";
import type { TaskFrontmatter } from "./schema.js";

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
      runner: { enabled: false },
      workingDirectory: "/tmp/x",
      roles: {
        planner: { tool: "mock", model: "m" },
        developer: { tool: "mock", model: "m" },
        reviewer: { tool: "mock", model: "m" },
      },
      models: { mock: ["m"] },
    };
    const path = dataPaths(root).settings;
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
    expect(resolveWorktreeRoot(s)).toBe("/tmp/x/.boof-runner-worktrees");
  });

  it("round-trips worktree and retry settings", async () => {
    const store = new SettingsStore(root);
    const s = defaultSettings("/tmp/x");
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
    const s = defaultSettings("/tmp/x");
    expect(resolveWorktreeRoot(s)).toBe("/tmp/x/.boof-runner-worktrees");
    s.worktree = { root: "../wt", onDone: "keep-branch", onFailure: "keep" };
    expect(resolveWorktreeRoot(s)).toBe("/tmp/wt");
    s.worktree.root = "~/wts/a";
    expect(resolveWorktreeRoot(s)).toBe(join(homedir(), "wts", "a"));
    s.worktree.root = "~";
    expect(resolveWorktreeRoot(s)).toBe(homedir());
    s.worktree.root = "/abs/wt";
    expect(resolveWorktreeRoot(s)).toBe("/abs/wt");
  });

  it("round-trips observer and review settings", async () => {
    const store = new SettingsStore(root);
    const s = defaultSettings("/tmp/x");
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
    const s = defaultSettings("/tmp/x");
    s.roles.observer = { tool: "mock", model: "global" };
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "task" } } }));
    expect(resolveObserver(s, task)?.model).toBe("task");
    expect(resolveObserver(s, newTask(fm()))?.model).toBe("global");
    expect(resolveRole(s, task, "reviewer")).toEqual(s.roles.reviewer);
  });

  it("resolveRole honours observer: task, then global, then undefined", () => {
    const s = defaultSettings("/tmp/x");
    expect(resolveRole(s, newTask(fm()), "observer")).toBeUndefined();
    s.roles.observer = { tool: "mock", model: "global" };
    expect(resolveRole(s, newTask(fm()), "observer")?.model).toBe("global");
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "task" } } }));
    expect(resolveRole(s, task, "observer")?.model).toBe("task");
  });
});
