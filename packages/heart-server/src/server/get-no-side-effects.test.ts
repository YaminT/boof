import { TEST_LOOPBACK_IS_UI } from "./test-ui-session.js";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  defaultSettings,
  EpicStore,
  newTask,
  PlanStore,
  SettingsStore,
  TaskStore,
  type Task,
  execCommand,
} from "@boof/heart";
import { MockTool, ToolRegistry, type HealthResult, type Tool } from "@boof/runner";
import { registry, TaskService } from "../api/index.js";
import { fakeWorkflow, startFakeN8n } from "../../test-support/fake-n8n.js";
import { createApp } from "./app.js";

/** A tool that counts every probe: a GET must never reach it. */
class SpyTool extends MockTool {
  probes = 0;
  override async detect(): Promise<HealthResult> {
    this.probes++;
    await new Promise((r) => setTimeout(r, 50)); // callers overlap while a check runs
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
let service: TaskService;

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
  service = new TaskService(root, new ToolRegistry([spy as Tool]));
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
  app = createApp({
    browserSessions: TEST_LOOPBACK_IS_UI,
    service,
    peerAddress: () => "127.0.0.1",
  });
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

describe("POST /health/check and /models/refresh", () => {
  const post = (path: string, key?: string) =>
    app.request(`http://localhost/api/v1${path}`, {
      method: "POST",
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
    });

  it("50 parallel checks run the tools once, and a second check within the cooldown runs nothing", async () => {
    const res = await Promise.all(Array.from({ length: 50 }, () => post("/health/check")));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(spy.probes).toBe(1);
    await post("/health/check");
    expect(spy.probes).toBe(1);
  });

  it("50 parallel model refreshes list the models once", async () => {
    const listModels = service.listModels.bind(service);
    let arrivals = 0;
    let release!: () => void;
    const allRequestsArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.listModels = () => {
      arrivals++;
      if (arrivals === 50) release();
      return allRequestsArrived.then(listModels);
    };

    await Promise.all(Array.from({ length: 50 }, () => post("/models/refresh")));
    expect(spy.probes).toBe(1);
  });

  it("running the tools needs settings:write; refreshing the models settings:read", async () => {
    const store = new AuthStore(root);
    const reader = (await store.create({ name: "reader", scopes: ["settings:read"] })).key;
    const writer = (await store.create({ name: "writer", scopes: ["settings:write"] })).key;
    app = createApp({
      browserSessions: TEST_LOOPBACK_IS_UI,
      service,
      authStore: store,
      peerAddress: () => "10.1.2.3",
    });
    expect((await post("/health/check", reader)).status).toBe(403);
    expect(spy.probes).toBe(0);
    expect((await post("/models/refresh", reader)).status).toBe(200);
    expect((await post("/health/check", writer)).status).toBe(200);
  });
});

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
    // Not registry operations: the public liveness check and the contract document.
    for (const path of ["/healthz", "/api/v1/openapi.json"]) {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status, path).toBeLessThan(500);
    }
    expect(await snapshot(root)).toEqual(before);
    expect(spy.probes).toBe(0);
  });

  it("GET /n8n and /n8n/workflows make no outbound call (O14)", async () => {
    const fake = await startFakeN8n({
      apiKey: "k",
      workflows: [fakeWorkflow({ id: "w1", name: "CI", webhook: { path: "ci" } })],
    });
    try {
      await service.settingsStore.mutate(
        (s) => ({ ...s, n8n: { baseUrl: fake.url, callbackBaseUrl: "https://b.x" } }) as typeof s,
      );
      const before = await snapshot(root);
      for (const path of ["/api/v1/n8n", "/api/v1/n8n/workflows"]) {
        const res = await app.request(`http://localhost${path}`);
        expect(res.status, path).toBe(200);
      }
      expect(fake.calls).toHaveLength(0);
      expect(await snapshot(root)).toEqual(before);
    } finally {
      await fake.close();
    }
  });

  it("do not create settings.json when it is missing", async () => {
    await rm(join(root, "settings.json"));
    for (const path of ["/api/v1/settings", "/healthz", "/api/v1/runner"]) {
      expect((await app.request(`http://localhost${path}`)).status, path).toBe(200);
    }
    await expect(stat(join(root, "settings.json"))).rejects.toThrow();
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
