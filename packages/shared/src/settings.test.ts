import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths } from "./paths.js";
import { resolveObserver, resolveRole, reviewSettings, SettingsStore } from "./settings.js";
import { defaultSettings } from "./settings.js";
import { newTask } from "./task-file.js";
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
});
