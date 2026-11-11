import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dataPaths,
  dataRootPaths,
  claudeAgentConfigDir,
  conciergeConfigDir,
  conciergeDir,
  conciergeScratchDir,
  InvalidIdError,
  projectPaths,
  taskAssetsDir,
  taskControlDir,
  taskFilePath,
  taskStopRequestPath,
  taskSteerRequestPath,
  workingAreaDir,
} from "./paths.js";
import { TaskStore } from "./store.js";

const BAD = ["..", "a/b", "A", "", "../x"];

describe("path builders reject non-kebab ids", () => {
  const builders: [string, (root: string, id: string) => unknown][] = [
    ["taskAssetsDir", taskAssetsDir],
    ["taskControlDir", taskControlDir],
    ["taskStopRequestPath", taskStopRequestPath],
    ["taskSteerRequestPath", taskSteerRequestPath],
    ["workingAreaDir", workingAreaDir],
    ["taskFilePath", (r, id) => taskFilePath(r, "pending", id)],
    ["projectPaths", projectPaths],
  ];
  for (const [name, fn] of builders) {
    it(`${name} throws InvalidIdError`, () => {
      for (const bad of BAD) expect(() => fn("/data", bad), bad).toThrow(InvalidIdError);
    });
  }

  it("accepts a valid id", () => {
    expect(() => taskAssetsDir("/data", "my-task-1")).not.toThrow();
  });
});

describe("data root layout v2 paths", () => {
  it("dataRootPaths and projectPaths", () => {
    const d = "/d";
    expect(dataRootPaths(d)).toMatchObject({
      root: d,
      settings: join(d, "settings.json"),
      runnerPid: join(d, ".runner.pid"),
      commands: join(d, "commands"),
      projects: join(d, "projects"),
      auth: join(d, "auth"),
      audit: join(d, "audit"),
      owlishProjectKeys: join(d, "owlish", "project-keys.json"),
      claudeAgentConfigs: join(d, "claude-agent-config"),
    });
    expect(projectPaths(d, "app")).toEqual({
      dir: join(d, "projects", "app"),
      json: join(d, "projects", "app", "project.json"),
      tasks: join(d, "projects", "app", "tasks"),
      plans: join(d, "projects", "app", "plans"),
      usage: join(d, "projects", "app", "usage.json"),
      events: join(d, "projects", "app", "events.jsonl"),
      epics: join(d, "projects", "app", "epics.json"),
    });
  });

  it("dataPaths stays as a deprecated alias", () => {
    expect(dataPaths("/d")).toMatchObject({
      settings: join("/d", "settings.json"),
      tasks: join("/d", "tasks"),
    });
  });

  it("builds isolated Claude config paths by project", () => {
    expect(claudeAgentConfigDir("/d", "app")).toBe(join("/d", "claude-agent-config", "app"));
    expect(() => claudeAgentConfigDir("/d", "../escape")).toThrow(InvalidIdError);
  });

  it("builds concierge directories under the data root", () => {
    expect(conciergeDir("/d", "app")).toBe(join("/d", "concierge", "app"));
    expect(conciergeConfigDir("/d", "app")).toBe(join("/d", "concierge", "app", "claude-config"));
    expect(conciergeScratchDir("/d", "app")).toBe(join("/d", "concierge", "app", "cwd"));
    expect(() => conciergeDir("/d", "../escape")).toThrow(InvalidIdError);
  });

  it("a project dir is a valid root for the task path helpers", () => {
    const { dir } = projectPaths("/d", "app");
    expect(taskFilePath(dir, "pending", "t1")).toBe(
      join("/d", "projects", "app", "tasks", "pending", "t1.md"),
    );
  });
});

describe("TaskStore id handling", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "boof-runner-paths-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("locate and get throw before touching disk", async () => {
    const store = new TaskStore(join(root, "does-not-exist"));
    await expect(store.locate("../x")).rejects.toThrow(InvalidIdError);
    await expect(store.get("../x")).rejects.toThrow(InvalidIdError);
  });
});
