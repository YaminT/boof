import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
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
import { pinnedRequest } from "../server/pinned-post.js";
import { startServer } from "../server/server.js";
import { N8nClient } from "./client.js";
import { writeWorkflowCache } from "./workflows.js";
import { MAX_CHECK_TASKS_PER_PASS, N8nWatcher, STOP_WAIT_MS } from "./watcher.js";

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

  it.skipIf(process.platform === "win32")(
    "M4 seen.json and workflows.json are written with mode 0600",
    async () => {
      await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
      const old = process.umask(0o000);
      try {
        await watcher().tick();
        await writeWorkflowCache(root, { fetchedAt: null, workflows: [] });
      } finally {
        process.umask(old);
      }
      const paths = dataRootPaths(root);
      if (process.platform !== "win32")
        expect((await stat(paths.n8nSeen)).mode & 0o777).toBe(0o600);
      if (process.platform !== "win32")
        expect((await stat(paths.n8nWorkflows)).mode & 0o777).toBe(0o600);
    },
  );

  it("first sight only records", async () => {
    const f = await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
    expect(await watcher().tick()).toEqual({ created: [], updated: [] });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8"))).toEqual({
      origin: new URL(f.url).origin,
      seen: { a: "2026-11-09T10:00:00.000Z" },
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
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8")).seen.g).toBe(
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
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8")).seen.a).toBe(
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

  it("cleans names from n8n: control, format and CRLF characters, length, empty", async () => {
    const evil = "Evil\u001b[31mRED\u0007\nline2\r\n## Inject\u0000z\u202Egnp.exe";
    const list = [
      fakeWorkflow({
        id: "e",
        name: evil,
        updatedAt: "2026-11-09T10:00:00.000Z",
        webhook: { path: "h-e" },
      }),
      fakeWorkflow({
        id: "l",
        name: "x".repeat(250),
        updatedAt: "2026-11-09T10:00:00.000Z",
        webhook: { path: "h-l" },
      }),
      fakeWorkflow({
        id: "z",
        name: "  \u0007\u202E ",
        updatedAt: "2026-11-09T10:00:00.000Z",
        webhook: { path: "h-z" },
      }),
    ];
    await setup({ workflows: list });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watcher();
    await w.tick();
    for (const x of list as { updatedAt: string }[]) x.updatedAt = "2026-11-09T11:00:00.000Z";
    expect((await w.tick()).created).toHaveLength(3);
    const byId = Object.fromEntries(
      (await tasksOf()).map((t) => [t.frontmatter.n8nCheck!.workflowId, t]),
    );
    const e = byId.e!;
    expect(e.frontmatter.n8nCheck!.workflowName).toBe("Evil [31mRED line2 ## Inject zgnp.exe");
    expect(e.frontmatter.title).toBe(
      'Check n8n workflow "Evil [31mRED line2 ## Inject zgnp.exe" after edit',
    );
    expect(`${e.frontmatter.title}${JSON.stringify(e.frontmatter.n8nCheck)}`).not.toMatch(
      /[\p{Cc}\p{Cf}]/u,
    );
    expect(e.body.prompt).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    const name = byId.l!.frontmatter.n8nCheck!.workflowName;
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith("…")).toBe(true);
    expect(byId.z!.frontmatter.n8nCheck!.workflowName).toBe("z");
    expect(warn).not.toHaveBeenCalled();
  });

  it("normalises an offset updatedAt to ISO UTC", async () => {
    const list = [wf("o", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    const w = watcher();
    await w.tick();
    list[0] = wf("o", "2026-11-09T12:00:00+01:00");
    expect((await w.tick()).created).toHaveLength(1);
    expect((await tasksOf())[0]!.frontmatter.n8nCheck!.updatedAt).toBe("2026-11-09T11:00:00.000Z");
    expect(await w.tick()).toEqual({ created: [], updated: [] });
  });

  it("an unusable updatedAt is skipped with one warning naming the workflow, and not retried", async () => {
    const list = [wf("u", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watcher();
    await w.tick();
    list[0] = wf("u", "not a date");
    for (let i = 0; i < 3; i++) expect(await w.tick()).toEqual({ created: [], updated: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("u (");
    expect(String(warn.mock.calls[0]![0])).not.toContain("shop");
    expect(await tasksOf()).toHaveLength(0);
  });

  it("caps tasks per pass: 200 changed workflows are all handled over later passes", async () => {
    const list = Array.from({ length: 200 }, (_, i) => wf(`w${i}`, "2026-11-09T10:00:00.000Z"));
    await setup({ workflows: list });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 0;
    const w = new N8nWatcher({
      root,
      service,
      client: new N8nClient({ root, env: {}, isSelfUrl: notSelf }),
      now: () => clock,
    });
    await w.tick();
    for (let i = 0; i < list.length; i++) list[i] = wf(`w${i}`, "2026-11-09T11:00:00.000Z");
    let total = 0;
    const first = await w.tick();
    expect(first.created).toHaveLength(MAX_CHECK_TASKS_PER_PASS);
    total += first.created.length;
    let passes = 1;
    while (total < 200 && passes < 100) {
      clock += 3_600_001; // the hourly cap is its own test
      const r = await w.tick();
      expect(r.created.length).toBeLessThanOrEqual(MAX_CHECK_TASKS_PER_PASS);
      total += r.created.length;
      passes++;
    }
    expect(total).toBe(200);
    expect(passes).toBe(20);
    expect(await tasksOf()).toHaveLength(200);
    clock += 3_600_001;
    expect(await w.tick()).toEqual({ created: [], updated: [] }); // done: no more work
  }, 240_000);

  it("caps tasks per hour and warns once", async () => {
    const list = Array.from({ length: 80 }, (_, i) => wf(`w${i}`, "2026-11-09T10:00:00.000Z"));
    await setup({ workflows: list });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watcher();
    await w.tick();
    for (let i = 0; i < list.length; i++) list[i] = wf(`w${i}`, "2026-11-09T11:00:00.000Z");
    let total = 0;
    for (let i = 0; i < 12; i++) total += (await w.tick()).created.length;
    expect(total).toBe(50);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("in the last hour"))).toHaveLength(
      1,
    );
  });

  it("a different n8n origin resets the seen state without creating tasks", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    await watcher().tick();
    // a second instance with the same ids but other timestamps
    const other = await startFakeN8n({
      apiKey: KEY,
      workflows: [wf("a", "2026-12-01T00:00:00.000Z")],
    });
    closers.push(other.close);
    const store = new SettingsStore(root);
    const settings = await store.load();
    await store.save({ ...settings, n8n: { ...settings.n8n!, baseUrl: other.url } });
    expect(await watcher().tick()).toEqual({ created: [], updated: [] });
    expect(await tasksOf()).toHaveLength(0);
    const saved = JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8"));
    expect(saved).toEqual({
      origin: new URL(other.url).origin,
      seen: { a: "2026-12-01T00:00:00.000Z" },
    });
  });

  it("stop() waits for the running pass, which then writes seen.json", async () => {
    await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const slow = (async (url: string, addrs: readonly string[], init: unknown) => {
      entered = true;
      await gate; // ignores the abort signal on purpose
      return pinnedRequest(url, addrs, { ...(init as object), signal: undefined } as never);
    }) as typeof pinnedRequest;
    const w = new N8nWatcher({
      root,
      service,
      client: new N8nClient({ root, env: {}, isSelfUrl: notSelf, request: slow }),
    });
    const pass = w.tick();
    // A fixed sleep races the pass: under load stop() can run before the request is
    // gated, find nothing to wait for, and return. Wait until the gate is held.
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 15_000 });
    let stopped = false;
    const stopping = w.stop().then(() => {
      stopped = true;
    });
    // The request ignores abort, so stop() stays pending until the gate opens
    // (or STOP_WAIT_MS). Flush promise reactions so an early return is visible.
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await stopping;
    await pass;
    expect(JSON.parse(await readFile(dataRootPaths(root).n8nSeen, "utf8")).seen.a).toBe(
      "2026-11-09T10:00:00.000Z",
    );
  }, 45_000);

  it("stop() aborts a hung request and returns within the bound", async () => {
    await setup({ workflows: [wf("a", "2026-11-09T10:00:00.000Z")] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let hung = false;
    const hungRequest = ((_u: string, _a: readonly string[], init: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        hung = true;
        const abort = () => rej(new Error("aborted"));
        if (init.signal?.aborted) {
          abort();
          return;
        }
        init.signal?.addEventListener("abort", abort, { once: true });
      })) as unknown as typeof pinnedRequest;
    const w = new N8nWatcher({
      root,
      service,
      client: new N8nClient({ root, env: {}, isSelfUrl: notSelf, request: hungRequest }),
    });
    const pass = w.tick();
    await vi.waitFor(() => expect(hung).toBe(true), { timeout: 15_000 });
    const t0 = Date.now();
    await w.stop();
    // Abort must beat the STOP_WAIT_MS race. That constant is the hang path.
    expect(Date.now() - t0).toBeLessThan(STOP_WAIT_MS);
    expect(await pass).toEqual({ created: [], updated: [] });
  }, 30_000);

  it("start() twice runs one timer chain; stop() then start() runs one", async () => {
    const f = await setup({
      workflows: [wf("a", "2026-11-09T10:00:00.000Z")],
      checks: { pollIntervalMs: 86_400_000 },
    });
    const w = watcher();
    w.start();
    w.start();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(f.calls).toHaveLength(1);
    await w.stop();
    w.start();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(f.calls).toHaveLength(2);
    await w.stop();
  });

  it("a finished check task does not absorb a new edit: a new draft is created", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    const first = await w.tick();
    const project = await service.requireProject("shop");
    for (const [i, status] of (["done", "failed"] as const).entries()) {
      const open = (await tasksOf()).filter((t) => t.frontmatter.status === "draft");
      expect(open).toHaveLength(1);
      const id = open[0]!.frontmatter.id;
      await project.tasks.transition(id, "pending");
      await project.tasks.transition(id, "running");
      await project.tasks.transition(id, status);
      list[0] = wf("a", `2026-11-09T1${2 + i}:00:00.000Z`);
      const next = await w.tick();
      expect(next.created).toHaveLength(1);
      expect(next.created[0]).not.toBe(first.created[0]);
    }
    expect(await tasksOf()).toHaveLength(3);
  });

  it("updating an open task refreshes its title and prompt and writes an audit line", async () => {
    const list = [wf("a", "2026-11-09T10:00:00.000Z")];
    await setup({ workflows: list });
    const w = watcher();
    await w.tick();
    list[0] = wf("a", "2026-11-09T11:00:00.000Z");
    await w.tick();
    list[0] = fakeWorkflow({
      id: "a",
      name: "Renamed",
      updatedAt: "2026-11-09T12:00:00.000Z",
      webhook: { path: "hook-a" },
    });
    expect((await w.tick()).updated).toHaveLength(1);
    const t = (await tasksOf())[0]!;
    expect(t.frontmatter.title).toBe('Check n8n workflow "Renamed" after edit');
    expect(t.body.prompt).toContain('"Renamed"');
    expect(t.body.prompt).toContain("2026-11-09T12:00:00.000Z");
    const audit = await readAudit();
    expect(audit.filter((l) => l.action === "n8n:check-task")).toHaveLength(2);
    expect(audit.at(-1)).toMatchObject({ workflowId: "a", updated: true });
  });

  it("the second server takes over the watcher after the first stops", async () => {
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
        webhookLockRetryMs: 100,
      });
    const first = await open();
    closers.push(() => first.stop());
    const second = await open();
    closers.push(() => second.stop());
    await vi.waitFor(() => expect(f.calls).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(f.calls).toHaveLength(1);
    await first.stop();
    closers.shift();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2), { timeout: 10_000 });
  });
});

describe("TaskService.createN8nCheckTask", () => {
  const check = {
    workflowId: "a",
    workflowName: "Flow a",
    webhookPath: "hook-a",
    updatedAt: "2026-11-09T10:00:00.000Z",
  };

  it("404 project_not_found for an unknown project", async () => {
    await expect(service.createN8nCheckTask("nope", check, { queue: false })).rejects.toMatchObject(
      {
        status: 404,
        code: "project_not_found",
      },
    );
  });

  it("audits with principal, via, workflow id and task, and no path", async () => {
    await makeProject();
    const made = await service.createN8nCheckTask("shop", check, { queue: false });
    const line = (await readAudit()).find((l) => l.action === "n8n:check-task")!;
    expect(line).toMatchObject({
      principal: "n8n-watcher",
      kind: "server",
      via: "server",
      project: "shop",
      outcome: "ok",
      workflowId: "a",
      task: made.id,
    });
    expect(JSON.stringify(line)).not.toContain("hook-a");
  });
});

async function readAudit(): Promise<{ action: string; [k: string]: unknown }[]> {
  const text = await readFile(
    join(dataRootPaths(root).audit, `${new Date().toISOString().slice(0, 10)}.jsonl`),
    "utf8",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
