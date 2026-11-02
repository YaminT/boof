import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
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
});
