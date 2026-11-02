import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWrite,
  AuthStore,
  readEvents,
  defaultSettings,
  EpicStore,
  newTask,
  serializeTask,
  SettingsStore,
  taskFilePath,
} from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
let repo: string;
let repo2: string;
let service: TaskService;
let app: ReturnType<typeof createApp>;

const V1 = "/api/v1";
const call = (path: string, init: RequestInit = {}) => app.request("http://localhost" + path, init);
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function gitDir(prefix: string) {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await execCommand("git", ["init", "-q"], { cwd: d });
  return d;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-hier-api-"));
  repo = await gitDir("boof-hier-repo-");
  repo2 = await gitDir("boof-hier-repo2-");
  await new SettingsStore(root).save(defaultSettings());
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  await service.projects.create({ workingDirectory: repo2, id: "other" });
  app = createApp({ service, peerAddress: () => "127.0.0.1" });
});
afterEach(async () => {
  for (const d of [root, repo, repo2]) {
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const mk = (title: string, extra: object = {}, project = "demo") =>
  call(`${V1}/projects/${project}/tasks`, send("POST", { title, prompt: "p", ...extra }));
const list = async (qs = "") => {
  const res = await call(`${V1}/projects/demo/tasks${qs}`);
  return { status: res.status, body: await res.json() };
};
const ids = (b: { items: { frontmatter: { id: string } }[] }) =>
  b.items.map((t) => t.frontmatter.id);
const epics = () => new EpicStore(service.projects.dir("demo"));

describe("task hierarchy over the API", () => {
  it("creates a subtask and shows progress on the parent", async () => {
    await epics().create({ title: "Web" });
    expect((await mk("Parent", { epicId: "web" })).status).toBe(201);
    const child = await mk("Child", { parentId: "parent" });
    expect(child.status).toBe(201);
    const p = await (await call(`${V1}/projects/demo/tasks/parent`)).json();
    expect(p.subtasks).toEqual({ total: 1, done: 0 });
    expect(p.epicId).toBe("web");
    const c = await (await call(`${V1}/projects/demo/tasks/child`)).json();
    expect(c.frontmatter.parentId).toBe("parent");
    expect(c.epicId).toBe("web");
    expect(c.frontmatter.epicId).toBeUndefined();
  });

  it("refuses bad placements", async () => {
    await epics().create({ title: "Web" });
    await mk("P");
    await mk("C", { parentId: "p" });
    await mk("Elsewhere", {}, "other");
    const code = async (extra: object) => {
      const r = await mk("X", extra);
      return [r.status, (await r.json()).error.code];
    };
    expect(await code({ epicId: "web", parentId: "p" })).toEqual([400, "invalid_input"]);
    expect(await code({ epicId: "nope" })).toEqual([404, "epic_not_found"]);
    expect(await code({ parentId: "nope" })).toEqual([404, "parent_not_found"]);
    expect(await code({ parentId: "c" })).toEqual([409, "invalid_hierarchy"]);
    expect(await code({ parentId: "elsewhere" })).toEqual([404, "parent_not_found"]);
  });

  it("lists by parent in priority order", async () => {
    await mk("P");
    await mk("Lo", { parentId: "p", priority: 10 });
    await mk("Hi", { parentId: "p", priority: 90 });
    await mk("Mid", { parentId: "p", priority: 50 });
    expect(ids((await list("?parent=p&order=priority")).body)).toEqual(["hi", "mid", "lo"]);
    expect(ids((await list("?parent=none")).body)).toEqual(["p"]);
  });

  it("filters by epic including subtasks; epic=none excludes them", async () => {
    await epics().create({ title: "Web" });
    await mk("P", { epicId: "web" });
    await mk("C", { parentId: "p" });
    await mk("Free");
    expect(ids((await list("?epic=web")).body).sort()).toEqual(["c", "p"]);
    expect(ids((await list("?epic=none")).body)).toEqual(["free"]);
  });

  it("pages order=priority without gaps or repeats", async () => {
    for (const [t, p] of [
      ["a", 5],
      ["b", 9],
      ["c", 5],
      ["d", 1],
      ["e", 7],
    ] as const) {
      await mk(t, { priority: p });
    }
    const all = ids((await list("?order=priority")).body);
    expect(all).toHaveLength(5);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await list(`?order=priority&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...ids(body));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
    const upd = await list("?limit=2");
    expect(upd.body.nextCursor).toBeTruthy();
    const bad = await list(`?order=priority&cursor=${upd.body.nextCursor}`);
    expect(bad.status).toBe(400);
    const bad2 = await list(`?limit=2&order=priority`);
    const bad3 = await list(`?cursor=${bad2.body.nextCursor}`);
    expect(bad3.status).toBe(400);
  });

  it("lists a hand-edited dangling subtask as top-level with parentMissing", async () => {
    const dir = service.projects.dir("demo");
    const t = newTask(
      {
        id: "orphan",
        title: "Orphan",
        status: "pending",
        priority: 1,
        skip: false,
        labels: [],
        command: null,
        attachments: [],
        questions: "none",
        runs: 1,
        completedRuns: 0,
        parentId: "ghost",
        created: "2026-06-04T10:00:00.000Z",
        updated: "2026-06-04T10:00:00.000Z",
      },
      "p",
    );
    await atomicWrite(taskFilePath(dir, "pending", "orphan"), serializeTask(t));
    const { body } = await list();
    expect(
      body.items.find((i: { frontmatter: { id: string } }) => i.frontmatter.id === "orphan")
        .parentMissing,
    ).toBe(true);
    expect(ids((await list("?parent=none")).body)).toContain("orphan");
  });

  it("lists pre-hierarchy task files unchanged", async () => {
    await mk("Plain");
    const v = (await list()).body.items[0];
    for (const k of ["epicId", "subtasks", "parentMissing", "epicMissing"])
      expect(v[k]).toBeUndefined();
  });

  it("keeps listing tasks when epics.json is corrupt, flagging their epic as missing", async () => {
    await epics().create({ title: "Web" });
    await mk("P", { epicId: "web" });
    await writeFile(join(service.projects.dir("demo"), "epics.json"), "{ not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { status, body } = await list();
      expect(status).toBe(200);
      expect(body.items[0].epicMissing).toBe(true);
      expect((await mk("Q")).status).toBe(201);
      expect((await call(`${V1}/projects/demo/tasks/p`)).status).toBe(200);
    } finally {
      err.mockRestore();
    }
  });

  const move = (id: string, body: unknown, key?: string) =>
    call(`${V1}/projects/demo/tasks/${id}/move`, send("POST", body), key);
  const code = async (r: Response) => [r.status, (await r.json()).error?.code];

  it("moves a task under a parent and back", async () => {
    await epics().create({ title: "Web" });
    await mk("P");
    await mk("T", { epicId: "web" });
    const under = await move("t", { parentId: "p" });
    expect(under.status).toBe(200);
    const view = await under.json();
    expect(view.frontmatter.parentId).toBe("p");
    expect(view.frontmatter.epicId).toBeUndefined();
    const back = await (await move("t", { parentId: null })).json();
    expect(back.frontmatter.parentId).toBeUndefined();
    const events = (await readEvents(service.projects.dir("demo"), null)).map((e) => e.event);
    expect(events.filter((e) => e.type === "task.moved").length).toBe(2);
  });

  it("refuses bad moves", async () => {
    await epics().create({ title: "Web" });
    await mk("P");
    await mk("Q");
    await mk("C", { parentId: "p" });
    expect((await move("q", { parentId: "p", epicId: "web" })).status).toBe(400);
    expect((await move("q", {})).status).toBe(400);
    expect(await code(await move("q", { parentId: "q" }))).toEqual([409, "invalid_hierarchy"]);
    expect(await code(await move("p", { parentId: "q" }))).toEqual([409, "has_children"]);
    expect(await code(await move("c", { epicId: "web" }))).toEqual([409, "invalid_hierarchy"]);
    expect(await code(await move("ghost", { epicId: null }))).toEqual([404, "not_found"]);
  });

  it("refuses to delete a parent unless detach, which keeps the epic", async () => {
    await epics().create({ title: "Web" });
    await mk("P", { epicId: "web" });
    await mk("C", { parentId: "p" });
    const del = (qs = "") => call(`${V1}/projects/demo/tasks/p${qs}`, { method: "DELETE" });
    expect(await code(await del())).toEqual([409, "has_children"]);
    const ok = await del("?detach=true");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, detached: ["c"] });
    const c = await (await call(`${V1}/projects/demo/tasks/c`)).json();
    expect(c.frontmatter.parentId).toBeUndefined();
    expect(c.frontmatter.epicId).toBe("web");
  });

  it("warns when queuing a parent with open subtasks", async () => {
    await mk("P");
    await mk("C", { parentId: "p" });
    const res = await call(`${V1}/projects/demo/tasks/p/queue`, send("POST"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Boof-Warning")).toContain("subtasks_open");
    expect((await res.json()).warnings[0].code).toBe("subtasks_open");
    await mk("P2");
    await mk("C2", { parentId: "p2" });
    await call(`${V1}/projects/demo/tasks/c2`, send("PUT", { status: "archived" }));
    const quiet = await call(`${V1}/projects/demo/tasks/p2/queue`, send("POST"));
    expect(quiet.status).toBe(200);
    expect(quiet.headers.get("Boof-Warning")).toBeNull();
  });

  it("review clients move only their own tasks and never detach", async () => {
    const store = new AuthStore(root);
    const rev = (
      await store.create({ name: "rev", scopes: ["tasks:read", "tasks:write"], trust: "review" })
    ).key;
    app = createApp({ service, authStore: store, peerAddress: () => "127.0.0.1" });
    const authed = (path: string, init: RequestInit) =>
      call(path, {
        ...init,
        headers: { ...(init.headers as object), authorization: `Bearer ${rev}` },
      });
    await mk("Human");
    const sub = await authed(
      `${V1}/projects/demo/tasks`,
      send("POST", { title: "Sub", prompt: "p", parentId: "human", status: "pending" }),
    );
    expect(sub.status).toBe(201);
    expect((await sub.json()).frontmatter.status).toBe("draft");
    expect(
      await code(
        await authed(`${V1}/projects/demo/tasks/human/move`, send("POST", { epicId: null })),
      ),
    ).toEqual([403, "forbidden_trust"]);
    expect(
      (await authed(`${V1}/projects/demo/tasks/sub/move`, send("POST", { parentId: null }))).status,
    ).toBe(200);
    expect(
      await code(await authed(`${V1}/projects/demo/tasks/human?detach=true`, { method: "DELETE" })),
    ).toEqual([403, "forbidden_trust"]);
  });
});
