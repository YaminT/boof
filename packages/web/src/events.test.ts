import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, AuthStore, defaultSettings, SettingsStore } from "@boof-runner/shared";
import { execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
let base: string;
let app: ReturnType<typeof createApp>;
let authStore: AuthStore;
let peer = "127.0.0.1";

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-events-web-")));
  root = join(base, "data");
  await mkdir(root, { recursive: true });
  await new SettingsStore(root).save(defaultSettings());
  const service = new TaskService(root, new ToolRegistry([new MockTool()]));
  for (const id of ["a", "b"]) {
    const repo = join(base, id);
    await mkdir(repo);
    await execCommand("git", ["init", "-q"], { cwd: repo });
    await service.projects.create({ workingDirectory: repo, id });
  }
  authStore = new AuthStore(root);
  peer = "127.0.0.1";
  app = createApp({ service, authStore, peerAddress: () => peer });
});

afterEach(() => rm(base, { recursive: true, force: true }));

const dir = (id: string) => join(root, "projects", id);
const taskStatus = (project: string, task: string) => ({
  type: "task.status" as const,
  project,
  task,
  from: "pending",
  to: "running",
  by: "runner",
});

interface Sse {
  event: string;
  id?: string;
  data: string;
}
const parse = (text: string): Sse[] =>
  text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => {
      const m: Sse = { event: "message", data: "" };
      for (const line of b.split("\n")) {
        if (line.startsWith("event:")) m.event = line.slice(6).trim();
        else if (line.startsWith("id:")) m.id = line.slice(3).trim();
        else if (line.startsWith("data:")) m.data += line.slice(5).trim();
      }
      return m;
    });
const stream = async (path: string, headers: Record<string, string> = {}) => {
  const res = await app.request(`http://localhost/api/v1/events${path}`, { headers });
  return { res, events: res.status === 200 ? parse(await res.text()) : [] };
};

describe("GET /api/v1/events", () => {
  it("sends only new events by default and replays everything for since=start", async () => {
    await appendEvent(dir("a"), taskStatus("a", "t1"));
    const live = await stream("");
    expect(live.res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(live.events.map((e) => e.event)).toEqual(["ready"]);
    const all = await stream("?since=start");
    expect(all.events.filter((e) => e.event === "task.status")).toHaveLength(1);
    expect(JSON.parse(all.events[1].data)).toMatchObject({
      type: "task.status",
      project: "a",
      task: "t1",
    });
  });

  it("resumes after a cursor, via ?since= and via Last-Event-ID", async () => {
    for (const t of ["t1", "t2", "t3"]) await appendEvent(dir("a"), taskStatus("a", t));
    const all = (await stream("?since=start")).events.filter((e) => e.event === "task.status");
    expect(all).toHaveLength(3);
    const viaQuery = await stream(`?since=${all[0].id}`);
    expect(
      viaQuery.events.filter((e) => e.event !== "ready").map((e) => JSON.parse(e.data).task),
    ).toEqual(["t2", "t3"]);
    const viaHeader = await stream("", { "Last-Event-ID": all[1].id! });
    expect(
      viaHeader.events.filter((e) => e.event !== "ready").map((e) => JSON.parse(e.data).task),
    ).toEqual(["t3"]);
    expect((await stream(`?since=${all[2].id}`)).events.filter((e) => e.event !== "ready")).toEqual(
      [],
    );
  });

  it("merges projects and global events in time order and filters by ?project", async () => {
    await appendEvent(dir("a"), taskStatus("a", "ta"), new Date("2026-10-01T00:00:01Z"));
    await appendEvent(
      root,
      { type: "runner.enabled", value: true, by: "local" },
      new Date("2026-10-01T00:00:02Z"),
    );
    await appendEvent(dir("b"), taskStatus("b", "tb"), new Date("2026-10-01T00:00:03Z"));
    const all = (await stream("?since=start")).events.filter((e) => e.event !== "ready");
    expect(all.map((e) => e.event)).toEqual(["task.status", "runner.enabled", "task.status"]);
    const onlyB = (await stream("?since=start&project=b")).events.filter(
      (e) => e.event !== "ready",
    );
    expect(onlyB.map((e) => JSON.parse(e.data).task)).toEqual(["tb"]);
    expect((await stream("?project=nope")).res.status).toBe(404);
    expect((await stream("?project=..%2Fx")).res.status).toBe(400);
  });

  it("never sends events of projects a restricted client may not read", async () => {
    await appendEvent(dir("a"), taskStatus("a", "ta"));
    await appendEvent(dir("b"), taskStatus("b", "tb"));
    const { key } = await authStore.create({
      name: "r",
      scopes: ["tasks:read"],
      projects: ["a"],
      trust: "trusted",
    });
    peer = "10.0.0.9";
    const headers = { authorization: `Bearer ${key}` };
    const res = await stream("?since=start", headers);
    expect(
      res.events.filter((e) => e.event === "task.status").map((e) => JSON.parse(e.data).task),
    ).toEqual(["ta"]);
    expect((await stream("?project=b", headers)).res.status).toBe(403);
    const noScope = await authStore.create({ name: "n", scopes: ["plans:read"], trust: "trusted" });
    expect((await stream("", { authorization: `Bearer ${noScope.key}` })).res.status).toBe(403);
  });

  it("rejects a cursor it did not issue", async () => {
    const res = await stream("?since=garbage");
    expect(res.res.status).toBe(400);
  });

  it("carries the events of real changes made through the API", async () => {
    const call = (path: string, init: RequestInit) => app.request(`http://localhost${path}`, init);
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await call("/api/v1/projects/a/plans", json("POST", { id: "p", title: "P" }));
    await call("/api/v1/projects/a/tasks", json("POST", { title: "T", status: "draft" }));
    await call("/api/v1/projects/a/tasks/t/queue", { method: "POST" });
    await call("/api/v1/runner", json("PUT", { enabled: true }));
    const events = (await stream("?since=start")).events
      .filter((e) => e.event !== "ready")
      .map((e) => JSON.parse(e.data));
    expect(events.map((e) => e.type)).toEqual(["plan.updated", "task.status", "runner.enabled"]);
    expect(events[1]).toMatchObject({ from: "draft", to: "pending", by: "local" });
  });
});
