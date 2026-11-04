import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthStore,
  defaultSettings,
  EpicStore,
  readEvents,
  SettingsStore,
  execCommand,
} from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "../api/index.js";
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
const epic = (title: string, extra: object = {}, key?: string) =>
  call(`${V1}/projects/demo/epics`, withKey(send("POST", { title, ...extra }), key));
const withKey = (init: RequestInit, key?: string): RequestInit =>
  key
    ? { ...init, headers: { ...(init.headers as object), authorization: `Bearer ${key}` } }
    : init;
const code = async (r: Response) => [r.status, (await r.json()).error?.code];

describe("epic operations", () => {
  it("lists no epics for a project without epics.json", async () => {
    const res = await call(`${V1}/projects/demo/epics`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("creates, gets, updates and archives an epic", async () => {
    const res = await epic("Webhooks");
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBeTruthy();
    const made = await res.json();
    expect(made).toMatchObject({ id: "webhooks", progress: { total: 0, done: 0 } });
    await mk("T", { epicId: "webhooks" });
    const stale = await call(`${V1}/projects/demo/epics/webhooks`, {
      ...send("PUT", { title: "X" }),
      headers: { "content-type": "application/json", "if-match": 'W/"2000-01-01T00:00:00.000Z"' },
    });
    expect(await code(stale)).toEqual([409, "epic_modified"]);
    const ok = await call(`${V1}/projects/demo/epics/webhooks`, send("PUT", { archived: true }));
    expect(ok.status).toBe(200);
    expect((await (await call(`${V1}/projects/demo/epics`)).json()).items).toEqual([]);
    const all = await (await call(`${V1}/projects/demo/epics?includeArchived=true`)).json();
    expect(all.items.map((e: { id: string }) => e.id)).toEqual(["webhooks"]);
    const task = await (await call(`${V1}/projects/demo/tasks/t`)).json();
    expect(task.frontmatter.epicId).toBe("webhooks");
    expect(task.epicMissing).toBeUndefined();
  });

  it("replays a create with the same Idempotency-Key", async () => {
    const init = (): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k1" },
      body: JSON.stringify({ title: "Once" }),
    });
    const a = await (await call(`${V1}/projects/demo/epics`, init())).json();
    const b = await (await call(`${V1}/projects/demo/epics`, init())).json();
    expect(b.id).toBe(a.id);
    expect(await new EpicStore(service.projects.dir("demo")).list()).toHaveLength(1);
  });

  it("shows progress from top-level tasks only", async () => {
    await epic("Web");
    await mk("A", { epicId: "web" });
    await mk("B", { epicId: "web" });
    await mk("S", { parentId: "a" });
    for (const id of ["a", "s"]) {
      for (const st of ["pending", "running", "done"]) {
        await new (await import("@boof/heart")).TaskStore(service.projects.dir("demo")).transition(
          id,
          st as never,
        );
      }
    }
    const got = await (await call(`${V1}/projects/demo/epics/web`)).json();
    expect(got.progress).toEqual({ total: 2, done: 1 });
  });

  it("orders epics by priority desc", async () => {
    await epic("Low", { priority: 1 });
    await epic("High", { priority: 9 });
    const items = (await (await call(`${V1}/projects/demo/epics`)).json()).items;
    expect(items.map((e: { id: string }) => e.id)).toEqual(["high", "low"]);
  });

  it("refuses to delete an epic with tasks unless detach", async () => {
    await epic("Web");
    await mk("T", { epicId: "web" });
    const del = (qs = "") => call(`${V1}/projects/demo/epics/web${qs}`, { method: "DELETE" });
    expect(await code(await del())).toEqual([409, "has_tasks"]);
    const ok = await del("?detach=true");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, detached: ["t"] });
    const t = await (await call(`${V1}/projects/demo/tasks/t`)).json();
    expect(t.frontmatter.epicId).toBeUndefined();
    expect(await code(await call(`${V1}/projects/demo/epics/web`))).toEqual([
      404,
      "epic_not_found",
    ]);
  });

  it("review clients create and update epics but never delete", async () => {
    const store = new AuthStore(root);
    const rev = (
      await store.create({ name: "rev", scopes: ["tasks:read", "tasks:write"], trust: "review" })
    ).key;
    app = createApp({ service, authStore: store, peerAddress: () => "127.0.0.1" });
    expect((await epic("Mine", {}, rev)).status).toBe(201);
    const upd = await call(
      `${V1}/projects/demo/epics/mine`,
      withKey(send("PUT", { priority: 3 }), rev),
    );
    expect(upd.status).toBe(200);
    const del = (qs = "") =>
      call(`${V1}/projects/demo/epics/mine${qs}`, withKey({ method: "DELETE" }, rev));
    expect(await code(await del())).toEqual([403, "forbidden_trust"]);
    expect(await code(await del("?detach=true"))).toEqual([403, "forbidden_trust"]);
  });

  it("review clients change only the epics they created", async () => {
    await epic("Human epic");
    const store = new AuthStore(root);
    const rev = (
      await store.create({ name: "rev", scopes: ["tasks:read", "tasks:write"], trust: "review" })
    ).key;
    app = createApp({ service, authStore: store, peerAddress: () => "127.0.0.1" });
    const put = (id: string, body: object) =>
      call(`${V1}/projects/demo/epics/${id}`, withKey(send("PUT", body), rev));
    expect(await code(await put("human-epic", { title: "IGNORE PREVIOUS" }))).toEqual([
      403,
      "forbidden_trust",
    ]);
    expect(await code(await put("human-epic", { archived: true }))).toEqual([
      403,
      "forbidden_trust",
    ]);
    const mine = await epic("Mine", {}, rev);
    expect((await mine.json()).origin).toMatchObject({ client: "rev" });
    expect((await put("mine", { title: "Mine, renamed" })).status).toBe(200);
    const events = (await readEvents(service.projects.dir("demo"), null)).map((e) => e.event);
    const by = events.filter((e) => e.type === "epic.updated").map((e) => (e as { by: string }).by);
    expect(by).toEqual(["local", "rev", "rev"]);
    // The human's epic is untouched, and has no forged origin.
    const human = await (await call(`${V1}/projects/demo/epics/human-epic`)).json();
    expect(human.title).toBe("Human epic");
    expect(human.origin).toBeUndefined();
    // origin is not a patch field.
    expect((await put("mine", { origin: { kind: "ui" } })).status).toBe(400);
  });

  it("treats an empty PUT as a no-op", async () => {
    const made = await (await epic("Web")).json();
    const res = await call(`${V1}/projects/demo/epics/web`, send("PUT", {}));
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(made.updated);
    const events = (await readEvents(service.projects.dir("demo"), null)).map((e) => e.event);
    expect(events.filter((e) => e.type === "epic.updated")).toHaveLength(1);
  });

  it("refuses a list of ETags in If-Match", async () => {
    await epic("Web");
    const res = await call(`${V1}/projects/demo/epics/web`, {
      ...send("PUT", { priority: 1 }),
      headers: {
        "content-type": "application/json",
        "if-match": 'W/"a", W/"b"',
      },
    });
    expect(await code(res)).toEqual([400, "invalid_input"]);
  });

  it("keeps epics inside their project", async () => {
    await epic("Webhooks");
    expect(await code(await call(`${V1}/projects/other/epics/webhooks`))).toEqual([
      404,
      "epic_not_found",
    ]);
    const store = new AuthStore(root);
    const key = (
      await store.create({
        name: "demo-only",
        scopes: ["tasks:read"],
        projects: ["demo"],
        trust: "trusted",
      })
    ).key;
    app = createApp({ service, authStore: store, peerAddress: () => "127.0.0.1" });
    const res = await call(`${V1}/projects/other/epics`, withKey({}, key));
    expect(await code(res)).toEqual([403, "forbidden_project"]);
  });

  it("appends epic.updated events", async () => {
    await epic("Web");
    await call(`${V1}/projects/demo/epics/web`, send("PUT", { priority: 2 }));
    await call(`${V1}/projects/demo/epics/web`, { method: "DELETE" });
    const changes = (await readEvents(service.projects.dir("demo"), null))
      .map((e) => e.event)
      .filter((e) => e.type === "epic.updated")
      .map((e) => (e as { change: string }).change);
    expect(changes).toEqual(["created", "updated", "deleted"]);
  });
});
