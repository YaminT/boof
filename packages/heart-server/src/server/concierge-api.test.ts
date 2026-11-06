import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, conciergeDir, defaultSettings, execCommand, SettingsStore } from "@boof/heart";
import { ClaudeConcierge, DESKTOP_CLAUDE_AGENT_REASON, MockTool, ToolRegistry } from "@boof/runner";
import { scriptedAgent } from "../concierge/fake-agent.js";
import { createApp } from "./app.js";
import { TaskService } from "../api/index.js";

let base: string;
let root: string;
let repo: string;
let service: TaskService;
let authStore: AuthStore;
let app: ReturnType<typeof createApp>;

const request = (path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init);
const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-concierge-api-")));
  root = join(base, "data");
  repo = join(base, "shop");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await new SettingsStore(root).save({ ...defaultSettings(), defaultProject: "shop" });
  service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.projects.create({ workingDirectory: repo, id: "shop" });
  authStore = new AuthStore(root);
  app = createApp({ service, authStore, peerAddress: () => "127.0.0.1" });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("concierge API", () => {
  it('"create a task to fix X" yields a draft task', async () => {
    const agent = scriptedAgent([
      { text: "I drafted a task." },
      { call: "boof_create_task", args: { projectId: "shop", title: "Fix X", prompt: "Fix X" } },
    ]);
    service = new TaskService(root, new ToolRegistry([new MockTool()]), { conciergeAgent: agent });
    app = createApp({ service, authStore, peerAddress: () => "127.0.0.1" });

    const response = await request(
      "/api/v1/projects/shop/concierge/messages",
      json("POST", { text: "create a task to fix X" }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).text).toContain("I drafted a task.");
    const tasks = await service.forProject("shop").list();
    expect(tasks.map((task) => [task.frontmatter.title, task.frontmatter.status])).toContainEqual([
      "Fix X",
      "draft",
    ]);
  });

  it("streams typed events in order", async () => {
    const agent = scriptedAgent([
      { text: "Need confirmation." },
      { call: "boof_delete_task", args: { projectId: "shop", taskId: "keep-me" } },
    ]);
    const scriptedTurn = agent.turn.bind(agent);
    agent.turn = async (input) => {
      let emitted = false;
      const onEvent = input.onEvent;
      input.onEvent = (event) => {
        onEvent?.(event);
        if (event.type === "text" && !emitted) {
          emitted = true;
          onEvent?.({ type: "tool", tool: "tasks.delete", phase: "start" });
        }
      };
      const result = await scriptedTurn(input);
      onEvent?.({ type: "tool", tool: "tasks.delete", phase: "end", ok: true });
      return result;
    };
    service = new TaskService(root, new ToolRegistry([new MockTool()]), { conciergeAgent: agent });
    app = createApp({ service, authStore, peerAddress: () => "127.0.0.1" });
    await service.forProject("shop").create({ title: "Keep me" });

    const response = await request(
      "/api/v1/projects/shop/concierge/messages/stream",
      json("POST", { text: "delete it" }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const body = await response.text();
    const events = [...body.matchAll(/^event: ([^\n]+)/gm)].map((match) => match[1]);
    expect(events).toEqual(["conversation", "text", "tool", "pending", "tool", "done"]);
  });

  it("requires project and scope access before returning concierge state", async () => {
    const restricted = await authStore.create({
      name: "other-project",
      scopes: ["tasks:read"],
      projects: ["elsewhere"],
    });
    const response = await request("/api/v1/projects/shop/concierge", {
      headers: { authorization: `Bearer ${restricted.key}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden_project" } });
    expect(existsSync(conciergeDir(root, "shop"))).toBe(false);
    const noScope = await authStore.create({ name: "no-read", scopes: [], projects: ["shop"] });
    const denied = await request("/api/v1/projects/shop/concierge", {
      headers: { authorization: `Bearer ${noScope.key}` },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "forbidden_scope" } });
  });

  it("does not expose another user's pending change", async () => {
    const agent = scriptedAgent([
      { call: "boof_delete_task", args: { projectId: "shop", taskId: "keep-me" } },
    ]);
    service = new TaskService(root, new ToolRegistry([new MockTool()]), { conciergeAgent: agent });
    app = createApp({ service, authStore, peerAddress: () => "127.0.0.1" });
    await service.forProject("shop").create({ title: "Keep me" });
    const ask = await request(
      "/api/v1/projects/shop/concierge/messages",
      json("POST", { text: "delete" }),
    );
    const { pending } = await ask.json();
    const other = await authStore.create({
      name: "other",
      scopes: ["tasks:read"],
      projects: ["shop"],
    });
    const apply = await request(
      `/api/v1/projects/shop/concierge/changes/${pending[0].id}/apply`,
      json("POST", {}, { authorization: `Bearer ${other.key}` }),
    );
    expect(apply.status).toBe(404);
    expect(await apply.json()).toMatchObject({ error: { code: "change_not_found" } });
    expect(
      (await service.forProject("shop").list()).some((task) => task.frontmatter.id === "keep-me"),
    ).toBe(true);
  });

  it("without an agent leaves Console A operations available", async () => {
    const status = await request("/api/v1/projects/shop/concierge");
    expect(await status.json()).toMatchObject({
      available: false,
      reason: "The assistant is not set up in this boof process.",
    });
    const ask = await request(
      "/api/v1/projects/shop/concierge/messages",
      json("POST", { text: "hello" }),
    );
    expect(ask.status).toBe(409);
    expect(await ask.json()).toMatchObject({ error: { code: "concierge_unavailable" } });
    const task = await request(
      "/api/v1/projects/shop/tasks",
      json("POST", { title: "Still works" }),
    );
    expect(task.status).toBe(201);
    const queue = await request("/api/v1/projects/shop/tasks/still-works/queue", json("POST", {}));
    expect(queue.status).toBe(200);
  });

  it("reports the desktop unavailable reason without loading the SDK", async () => {
    const loadSdk = vi.fn();
    const agent = new ClaudeConcierge({
      root,
      unavailableReason: DESKTOP_CLAUDE_AGENT_REASON,
      loadSdk: loadSdk as never,
      resolveExecutable: vi.fn() as never,
    });
    service = new TaskService(root, new ToolRegistry([new MockTool()]), { conciergeAgent: agent });
    app = createApp({ service, authStore, peerAddress: () => "127.0.0.1" });
    const response = await request("/api/v1/projects/shop/concierge");
    expect(await response.json()).toMatchObject({
      available: false,
      reason: DESKTOP_CLAUDE_AGENT_REASON,
    });
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it("returns stream preflight refusals as JSON before opening the stream", async () => {
    const response = await request(
      "/api/v1/projects/shop/concierge/messages/stream",
      json("POST", { text: "   " }),
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.status).toBe(400);
  });

  it('"delete" asks first; apply deletes and discard leaves the task', async () => {
    const agent = scriptedAgent([
      { call: "boof_delete_task", args: { projectId: "shop", taskId: "apply-me" } },
      { call: "boof_delete_task", args: { projectId: "shop", taskId: "keep-me" } },
    ]);
    service = new TaskService(root, new ToolRegistry([new MockTool()]), { conciergeAgent: agent });
    app = createApp({ service, authStore, peerAddress: () => "127.0.0.1" });
    await service.forProject("shop").create({ title: "Apply me" });
    await service.forProject("shop").create({ title: "Keep me" });
    const first = await request(
      "/api/v1/projects/shop/concierge/messages",
      json("POST", { text: "delete" }),
    );
    const firstPending = (await first.json()).pending[0];
    expect((await service.forProject("shop").get("apply-me"))?.frontmatter.status).toBe("draft");
    const applied = await request(
      `/api/v1/projects/shop/concierge/changes/${firstPending.id}/apply`,
      json("POST", {}),
    );
    expect(applied.status).toBe(200);
    expect(await service.forProject("shop").get("apply-me")).toBeNull();

    const second = await request(
      "/api/v1/projects/shop/concierge/messages",
      json("POST", { text: "delete another" }),
    );
    const secondPending = (await second.json()).pending[0];
    const discarded = await request(
      `/api/v1/projects/shop/concierge/changes/${secondPending.id}/discard`,
      json("POST", {}),
    );
    expect(discarded.status).toBe(200);
    expect((await service.forProject("shop").get("keep-me"))?.frontmatter.title).toBe("Keep me");
  });
});
