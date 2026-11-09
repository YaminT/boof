import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  execCommand,
  N8nSecretStore,
  N8nSettingsSchema,
  dataRootPaths,
  SettingsStore,
  TaskStore,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof/runner";
import { fakeWorkflow, notSelf, startFakeN8n } from "../../test-support/fake-n8n.js";
import { TaskService } from "../api/index.js";
import { startServer } from "../server/server.js";
import { N8nClient } from "./client.js";
import { N8nWatcher } from "./watcher.js";

const KEY = "n8n_api_KEY_secret_value";
let root: string;
let service: TaskService;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-n8n-watch-"));
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await rm(root, { recursive: true, force: true });
  for (const r of repos.splice(0)) await rm(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const repos: string[] = [];
async function makeProject(): Promise<void> {
  if (await service.projects.get("shop")) return;
  const repo = await realpath(await mkdtemp(join(tmpdir(), "boof-n8n-watch-proj-")));
  repos.push(repo);
  await execCommand("git", ["init", "-q"], { cwd: repo });
  await service.projects.create({ workingDirectory: repo, id: "shop" });
}

async function setup(opts: {
  workflows: unknown[];
  checks?: Record<string, unknown> | null;
  project?: boolean;
  n8n?: boolean;
}) {
  const f = await startFakeN8n({ apiKey: KEY, workflows: opts.workflows });
  closers.push(f.close);
  const settings = defaultSettings();
  await new SettingsStore(root).save({
    ...settings,
    ...(opts.n8n === false
      ? {}
      : {
          n8n: N8nSettingsSchema.parse({
            baseUrl: f.url,
            callbackBaseUrl: "https://boof.example",
            ...(opts.checks === null
              ? {}
              : { checks: { enabled: true, projectId: "shop", ...opts.checks } }),
          }),
        }),
  });
  await new N8nSecretStore(root, {}).setApiKey(KEY);
  if (opts.project !== false) {
    await makeProject();
  }
  return f;
}

const watcher = () =>
  new N8nWatcher({
    root,
    service,
    client: new N8nClient({ root, env: {}, isSelfUrl: notSelf }),
  });

const wf = (
  id: string,
  updatedAt: string,
  webhook: { path: string; method?: string } | null = { path: "hook-" + id },
) => fakeWorkflow({ id, name: `Flow ${id}`, updatedAt, webhook });

const tasksOf = () => new TaskStore(service.projects.dir("shop")).list();

describe("N8nWatcher", () => {
  it("disabled or absent checks: no request, no file", async () => {
    const f1 = await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")], checks: null });
    expect(await watcher().tick()).toEqual({ created: [], updated: [] });
    expect(f1.calls).toHaveLength(0);
    const f2 = await setup({
      workflows: [wf("a", "2026-11-09T10:00:00.000Z")],
      checks: { enabled: false },
    });
    await watcher().tick();
    expect(f2.calls).toHaveLength(0);
    const f3 = await setup({ workflows: [], n8n: false });
    await watcher().tick();
    expect(f3.calls).toHaveLength(0);
    await expect(readFile(dataRootPaths(root).n8nSeen, "utf8")).rejects.toThrow();
  });

  it("first sight only records", async () => {
    const f = await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
    expect(await watcher().tick()).toEqual({ created: [], updated: [] });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8"))).toEqual({
      a: "2026-11-09T10:00:00.000Z",
    });
    expect(await tasksOf()).toHaveLength(0);
    // unchanged → still nothing
    expect(await watcher().tick()).toEqual({ created: [], updated: [] });
    expect(await tasksOf()).toHaveLength(0);
  });

  it("an edit creates one draft check task with the n8nCheck block", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    const res = await w.tick();
    expect(res.created).toHaveLength(1);
    const tasks = await tasksOf();
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.frontmatter.status).toBe("draft");
    expect(t.frontmatter.labels).toEqual(["n8n-check"]);
    expect(t.frontmatter.title).toBe('Check n8n workflow "Flow a" after edit');
    expect(t.frontmatter.n8nCheck).toEqual({
      workflowId: "a",
      workflowName: "Flow a",
      webhookPath: "hook-a",
      updatedAt: "2026-11-09T11:00:00.000Z",
    });
    expect(t.body.prompt).toContain('"Flow a" (a)');
    expect(t.body.prompt).toContain("2026-11-09T11:00:00.000Z");
    expect(res.created[0]).toBe(t.frontmatter.id);
    // not re-created on the next pass
    expect(await w.tick()).toEqual({ created: [], updated: [] });
    // audit line without secrets
    const audit = await readFile(
      join(dataRootPaths(root).audit, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      "utf8",
    );
    expect(audit).toContain("n8n:check-task");
    expect(audit).not.toContain(KEY);
  });

  it("a second edit while that task is open updates it instead of creating another", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    const first = await w.tick();
    list[0] = wf("a", "2026-11-09T12:00:00.000Z", { path: "moved" });
    const second = await w.tick();
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(first.created);
    const tasks = await tasksOf();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.frontmatter.n8nCheck).toMatchObject({
      updatedAt: "2026-11-09T12:00:00.000Z",
      webhookPath: "moved",
    });
  });

  it("autoQueue creates it pending", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list, checks: { autoQueue: true } });
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    await w.tick();
    expect((await tasksOf())[0]!.frontmatter.status).toBe("pending");
  });

  it("a workflow with only a GET webhook gets no task", async () => {
    const list = [wf("g", "2026-11-09T10:00:00.000Z", { path: "g", method: "GET" })];
    await setup({ workflows: list });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watcher();
    await w.tick();
    list[0] = wf("g", "2026-11-09T11:00:00.000Z", { path: "g", method: "GET" });
    expect(await w.tick()).toEqual({ created: [], updated: [] });
    expect(await tasksOf()).toHaveLength(0);
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8")).g).toBe(
      "2026-11-09T11:00:00.000Z",
    );
    expect(warn).toHaveBeenCalledTimes(1); // once per updatedAt
    await w.tick();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh creates nothing and is retried next pass", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    const f = await setup({ workflows: list });
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    await new N8nSecretStore(root, {}).setApiKey("wrong-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await w.tick()).toEqual({ created: [], updated: [] });
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8")).a).toBe(
      "2026-11-09T10:00:00.000Z",
    );
    await new N8nSecretStore(root, {}).setApiKey(KEY);
    expect((await w.tick()).created).toHaveLength(1);
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("a missing check project creates nothing and the edit is retried once the project exists", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list, project: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    expect(await w.tick()).toEqual({ created: [], updated: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    await makeProject();
    expect((await w.tick()).created).toHaveLength(1);
  });

  it("tick is not re-entrant", async () => {
    await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
    const w = watcher();
    const [a, b] = await Promise.all([w.tick(), w.tick()]);
    expect(a).toEqual({ created: [], updated: [] });
    expect(b).toEqual({ created: [], updated: [] });
  });

  it("an overlapping tick makes no second request", async () => {
    const f = await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
    const w = watcher();
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    expect(f.calls).toHaveLength(1);
  });

  it("only the server holding the dispatcher lock runs the watcher", async () => {
    const f = await setup({
      workflows: [wf("a", "2026-11-09T10:00:00.000Z")],
      checks: { pollIntervalMs: 86_400_000 },
    });
    const open = () =>
      startServer({
        catalog: new ToolRegistry([new MockTool()]),
        root,
        port: 0,
        warn: () => {},
        webhookLockRetryMs: 60_000,
      });
    const first = await open();
    closers.push(() => first.stop());
    const second = await open();
    closers.push(() => second.stop());
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(f.calls).toHaveLength(1); // one pass, by one server
    await second.stop();
    closers.pop();
    expect(f.calls).toHaveLength(1);
  });
});
