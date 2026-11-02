import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  EpicStore,
  newTask,
  PlanStore,
  SettingsStore,
  TaskStore,
  type Task,
} from "@boof-runner/shared";
import {
  execCommand,
  MockTool,
  ToolRegistry,
  type HealthResult,
  type Tool,
} from "@boof-runner/runner";
import { registry, TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

/** A tool that counts every probe: a GET must never reach it. */
class SpyTool extends MockTool {
  probes = 0;
  override async detect(): Promise<HealthResult> {
    this.probes++;
    return super.detect();
  }
  override async listModels(): Promise<string[]> {
    this.probes++;
    return super.listModels();
  }
}

let root: string;
let repo: string;
let spy: SpyTool;
let app: ReturnType<typeof createApp>;

/** path → size and mtime of everything under the data root, the audit log excluded (it records the calls). */
async function snapshot(
  dir: string,
  out: Record<string, string> = {},
): Promise<Record<string, string>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(root, full);
    if (rel === "audit") continue;
    if (e.isDirectory()) {
      out[rel + "/"] = "dir";
      await snapshot(full, out);
    } else {
      const s = await stat(full);
      out[rel] = `${s.size}:${s.mtimeMs}`;
    }
  }
  return out;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "boof-get-")));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-get-repo-")));
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await new SettingsStore(root).save(defaultSettings());
  spy = new SpyTool();
  const service = new TaskService(root, new ToolRegistry([spy as Tool]));
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  const dir = service.projects.dir("demo");
  await new TaskStore(dir).create(
    newTask(
      {
        id: "t1",
        title: "T1",
        status: "pending",
        priority: 1,
        skip: false,
        labels: [],
        command: null,
        attachments: [],
        questions: "none",
        runs: 1,
        completedRuns: 0,
        created: "",
        updated: "",
      } as Task["frontmatter"],
      "p",
    ),
  );
  await new EpicStore(dir).create({ title: "E" });
  await new PlanStore(dir).create({
    id: "p1",
    title: "P",
    status: "draft",
    source: { kind: "api" },
    goals: [],
  });
  app = createApp({ service, peerAddress: () => "127.0.0.1" });
  spy.probes = 0;
});
afterEach(async () => {
  for (const d of [root, repo]) await rm(d, { recursive: true, force: true, maxRetries: 10 });
});

const FILL: Record<string, string> = {
  projectId: "demo",
  taskId: "t1",
  planId: "p1",
  epicId: "e",
};
const WAITS = new Set(["tasks.wait", "plans.wait"]);

describe("GET operations", () => {
  it("never change the data root and never run a tool", async () => {
    const gets = registry.filter((o) => o.rest.method === "GET" && !WAITS.has(o.name));
    expect(gets.length).toBeGreaterThan(15);
    const before = await snapshot(root);
    for (const op of gets) {
      const path = op.rest.path.replace(/\{(\w+)\}/g, (_m, k: string) => FILL[k] ?? "x");
      const res = await app.request(`http://localhost/api/v1${path}`);
      expect(res.status, `${op.name} ${path}`).toBeLessThan(500);
    }
    expect(await snapshot(root)).toEqual(before);
    expect(spy.probes).toBe(0);
  });

  it("GET /health and /models answer from the last probe; POST runs it", async () => {
    const get = async (p: string) => (await app.request(`http://localhost/api/v1${p}`)).json();
    expect((await get("/health")).tools).toEqual({});
    expect((await get("/models")).models.mock).toEqual(["mock-default"]);
    expect(spy.probes).toBe(0);
    const checked = await (
      await app.request("http://localhost/api/v1/health/check", { method: "POST" })
    ).json();
    expect(checked.tools.mock.status).toBe("available");
    expect(spy.probes).toBe(1);
    expect((await get("/health")).tools.mock).toMatchObject({ status: "available" });
    expect((await get("/health")).tools.mock.checkedAt).toBeTruthy();
    const refreshed = await (
      await app.request("http://localhost/api/v1/models/refresh", { method: "POST" })
    ).json();
    expect(refreshed.models.mock).toEqual(["mock-default"]);
    expect(spy.probes).toBe(2);
    await get("/models");
    await get("/models/details");
    expect(spy.probes).toBe(2);
  });
});
