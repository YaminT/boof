import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AuthStore,
  BOOF_VERSION,
  defaultSettings,
  LOCAL_PRINCIPAL,
  SettingsStore,
  type Principal,
  type Scope,
} from "@boof-runner/shared";
import { execCommand, resetMock, RunnerEngine } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import {
  closeWhenDrained,
  createBoofMcpServer,
  handleMcpHttp,
  exposedOps,
  principalFromClient,
  stdioPrincipal,
  type BoofMcpOptions,
  type ToolCallInfo,
} from "./index.js";

let base: string;
let root: string;
let repo: string;
let services: TaskService;
let authStore: AuthStore;
const open: Client[] = [];

const spec = (goal: string) => ({
  goal,
  stack: "TypeScript",
  rules: { do: ["Write a failing test first."] },
  tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
});
const goal = (id: string, deps: string[] = []) => ({
  id,
  title: id.toUpperCase(),
  dependsOn: deps,
  spec: spec(`Build ${id}`),
});

async function connect(
  principal: Principal,
  project?: string,
  extra: Partial<BoofMcpOptions> = {},
): Promise<Client> {
  const server = createBoofMcpServer({ root, principal, services, authStore, project, ...extra });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  open.push(client);
  return client;
}

async function clientPrincipal(
  scopes: Scope[],
  trust: "trusted" | "review",
  projects: string[] | "*" = "*",
): Promise<Principal> {
  const { client } = await authStore.create({ name: "agent", scopes, trust, projects });
  return principalFromClient((await authStore.get(client.id))!);
}

type Result = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
};
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as Result;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-mcp-")));
  root = join(base, "data");
  repo = join(base, "repos", "shop");
  await mkdir(repo, { recursive: true });
  const g = (args: string[]) => execCommand("git", args, { cwd: repo, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(repo, "README.md"), "# shop\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);

  const settings = defaultSettings();
  settings.runner.enabled = true;
  settings.roles = {
    planner: { tool: "mock", model: "mock-default" },
    developer: { tool: "mock", model: "mock-default" },
    reviewer: { tool: "mock", model: "mock-default" },
  };
  await new SettingsStore(root).save(settings);
  services = new TaskService(root);
  authStore = new AuthStore(root);
  resetMock();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

describe("tools generated from the registry", () => {
  it("a cancelled boof_wait_task releases the server-side wait at once", async () => {
    let finished!: (info: ToolCallInfo) => void;
    const done = new Promise<ToolCallInfo>((r) => (finished = r));
    const admin = await connect(LOCAL_PRINCIPAL, undefined, {
      onCall: (info) => {
        if (info.tool === "boof_wait_task") finished(info);
      },
    });
    await call(admin, "boof_create_project", { workingDirectory: repo, id: "shop" });
    await call(admin, "boof_create_task", { projectId: "shop", title: "Idle", status: "pending" });
    const ctrl = new AbortController();
    const started = Date.now();
    const pending = admin.callTool(
      {
        name: "boof_wait_task",
        arguments: { projectId: "shop", taskId: "idle", timeoutSeconds: 30 },
      },
      undefined,
      { signal: ctrl.signal },
    );
    await new Promise((r) => setImmediate(r));
    ctrl.abort(); // the client sends notifications/cancelled and rejects locally
    await expect(pending).rejects.toThrow();
    // The server side is the proof: onCall fires only when the handler returned.
    const info = await done;
    expect(info).toMatchObject({ tool: "boof_wait_task", ok: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("lists the tools with their scopes (snapshot of names)", async () => {
    const client = await connect(LOCAL_PRINCIPAL);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toMatchInlineSnapshot(`
      [
        "boof_whoami",
        "boof_list_projects",
        "boof_create_project",
        "boof_get_project",
        "boof_update_project",
        "boof_list_plans",
        "boof_create_plan",
        "boof_get_plan",
        "boof_update_plan",
        "boof_replace_goals",
        "boof_upsert_goal",
        "boof_remove_goal",
        "boof_reorder_goals",
        "boof_set_goal_status",
        "boof_import_plan",
        "boof_export_plan",
        "boof_sync_plan",
        "boof_wait_plan",
        "boof_list_tasks",
        "boof_get_task",
        "boof_get_task_diff",
        "boof_create_task",
        "boof_update_task",
        "boof_queue_task",
        "boof_retry_task",
        "boof_archive_task",
        "boof_answer_task",
        "boof_stop_task",
        "boof_inject_prompt",
        "boof_get_task_log",
        "boof_wait_task",
        "boof_runner_status",
        "boof_set_runner",
        "boof_list_actions",
      ]
    `);
    expect(names.length).toBeLessThanOrEqual(34);
    const scopesByTool = Object.fromEntries(
      exposedOps(await import("@boof-runner/api").then((m) => m.registry)).map((o) => [
        o.mcp.name,
        o.scopes.join("|"),
      ]),
    );
    expect(scopesByTool).toMatchObject({
      boof_list_projects: "projects:read",
      boof_create_plan: "plans:write",
      boof_stop_task: "tasks:control",
      boof_wait_task: "tasks:read",
      boof_runner_status: "settings:read",
      boof_set_runner: "runner:control|settings:write",
    });
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeDefined();
    }
  });

  it("boof_whoami needs no scope and reports the principal", async () => {
    const principal = await clientPrincipal(["plans:read"], "review", ["shop"]);
    const client = await connect(principal);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("boof_whoami");
    const r = await call(client, "boof_whoami");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      principal: {
        kind: "client",
        name: "agent",
        trust: "review",
        scopes: ["plans:read"],
        projects: ["shop"],
      },
      server: { version: BOOF_VERSION, authMode: "local-trust", mcpEnabled: true },
    });
  });

  it("lists only the tools the client's scopes allow", async () => {
    const reader = await connect(await clientPrincipal(["plans:read", "tasks:read"], "review"));
    const names = (await reader.listTools()).tools.map((t) => t.name);
    expect(names).toContain("boof_get_plan");
    expect(names).toContain("boof_wait_task");
    expect(names).not.toContain("boof_create_plan");
    expect(names).not.toContain("boof_stop_task");
    expect(names).not.toContain("boof_set_runner");
  });

  it("hides projectId and injects the project with a fixed project", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const client = await connect(LOCAL_PRINCIPAL, "shop");
    const tools = (await client.listTools()).tools;
    const listTasks = tools.find((t) => t.name === "boof_list_tasks")!;
    expect(Object.keys(listTasks.inputSchema.properties ?? {})).not.toContain("projectId");
    expect(tools.map((t) => t.name)).not.toContain("boof_create_project");
    const res = await call(client, "boof_list_tasks");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.items).toEqual([]);
  });

  it("runs the whole flow: project, plan, sync, tasks, run, wait, review draft, conflict, log", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);

    const created = await call(admin, "boof_create_project", {
      workingDirectory: repo,
      id: "shop",
    });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent?.id).toBe("shop");

    const plan = await call(admin, "boof_create_plan", {
      projectId: "shop",
      id: "q4",
      title: "Q4",
      status: "active",
      goals: [goal("a"), goal("b", ["a"])],
    });
    expect(plan.isError).toBeFalsy();
    expect(plan.structuredContent?.version).toBe(1);

    const sync = await call(admin, "boof_sync_plan", { projectId: "shop", planId: "q4" });
    expect(sync.structuredContent?.created).toHaveLength(1);
    const taskId = sync.structuredContent!.created[0].taskId as string;

    const pending = await call(admin, "boof_list_tasks", { projectId: "shop", status: "pending" });
    expect(pending.structuredContent?.items).toHaveLength(1);
    expect(pending.content[0].text).toContain(taskId);

    // The task is not running yet: a short wait times out without a change.
    const idle = await call(admin, "boof_wait_task", {
      projectId: "shop",
      taskId,
      timeoutSeconds: 1,
    });
    expect(idle.structuredContent).toMatchObject({ changed: false, timedOut: true });

    // Run the engine in the background and wait for the status change over MCP.
    const engine = new RunnerEngine({ root, pollIntervalMs: 10 });
    const running = engine.runUntilIdle();
    const waited = await call(admin, "boof_wait_task", {
      projectId: "shop",
      taskId,
      until: "done",
      timeoutSeconds: 30,
    });
    await running;
    expect(waited.structuredContent?.changed).toBe(true);
    const after = await call(admin, "boof_get_task", { projectId: "shop", taskId });
    expect(after.structuredContent?.frontmatter.status).toBe("done");
    expect(after.structuredContent?.body).not.toHaveProperty("log");

    const status = await call(admin, "boof_runner_status");
    expect(status.structuredContent?.projects[0]).toMatchObject({ id: "shop", paused: false });

    // A review-trust client cannot queue work: its task is a draft.
    const reviewer = await connect(
      await clientPrincipal(["tasks:write", "tasks:read"], "review", ["shop"]),
    );
    const draft = await call(reviewer, "boof_create_task", {
      projectId: "shop",
      title: "Proposal",
      prompt: "Please add a changelog",
      status: "pending",
    });
    expect(draft.isError).toBeFalsy();
    expect(draft.structuredContent?.frontmatter.status).toBe("draft");
    expect(draft.content[0].text).toContain("draft");
    const refused = await call(reviewer, "boof_queue_task", {
      projectId: "shop",
      taskId: draft.structuredContent!.frontmatter.id,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^forbidden_trust: /);

    // A stale expectedVersion is a tool error with the REST code.
    const current = await call(admin, "boof_get_plan", { projectId: "shop", planId: "q4" });
    const v = current.structuredContent!.version as number;
    const ok = await call(admin, "boof_update_plan", {
      projectId: "shop",
      planId: "q4",
      title: "Q4 plan",
      expectedVersion: v,
    });
    expect(ok.isError).toBeFalsy();
    const stale = await call(admin, "boof_update_plan", {
      projectId: "shop",
      planId: "q4",
      title: "Again",
      expectedVersion: v,
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(/^plan_version_conflict: /);

    // A tool without the scope and a malformed input both fail with REST codes.
    const noScope = await call(reviewer, "boof_set_runner", { enabled: false });
    expect(noScope.isError).toBe(true);
    expect(noScope.content[0].text).toMatch(/^forbidden_scope: /);
    const bad = await call(admin, "boof_get_task", { projectId: "shop", taskId: "../x" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^invalid_input: /);
    const unknown = await call(admin, "boof_get_task", { projectId: "shop", extra: 1 });
    expect(unknown.isError).toBe(true);
  });

  it("refuses a project outside the client's restriction", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const client = await connect(await clientPrincipal(["tasks:read"], "review", ["other"]));
    const res = await call(client, "boof_list_tasks", { projectId: "shop" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^forbidden_project: /);
  });

  it("advertises no listChanged notifications (the HTTP server is stateless)", async () => {
    const client = await connect(LOCAL_PRINCIPAL);
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
  });
});

describe("resources", () => {
  it("reads projects, plans, exported xml, tasks and a task log", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);
    await call(admin, "boof_create_project", { workingDirectory: repo, id: "shop" });
    await call(admin, "boof_create_plan", {
      projectId: "shop",
      id: "q4",
      title: "Q4",
      status: "active",
      goals: [goal("a")],
    });
    const sync = await call(admin, "boof_sync_plan", { projectId: "shop", planId: "q4" });
    const taskId = sync.structuredContent!.created[0].taskId as string;
    await new RunnerEngine({ root, pollIntervalMs: 10 }).runUntilIdle();

    const text = async (uri: string) =>
      (await admin.readResource({ uri })).contents[0] as { text: string; mimeType: string };

    expect(JSON.parse((await text("boof://projects")).text).projects[0].id).toBe("shop");
    expect(JSON.parse((await text("boof://projects/shop")).text).id).toBe("shop");
    expect(JSON.parse((await text("boof://projects/shop/plans/q4")).text).goals).toHaveLength(1);
    const xml = await text("boof://projects/shop/plans/q4/xml");
    expect(xml.mimeType).toBe("text/plain");
    expect(xml.text).toContain("<");
    expect((await text("boof://projects/shop/plans/q4/xml/a")).text).toContain("<");
    const task = JSON.parse((await text(`boof://projects/shop/tasks/${taskId}`)).text);
    expect(task.frontmatter.status).toBe("done");
    const log = await text(`boof://projects/shop/tasks/${taskId}/log`);
    expect(log.mimeType).toBe("text/plain");
    expect(typeof log.text).toBe("string");

    const { resources } = await admin.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("boof://projects");
    expect(uris).toContain("boof://projects/shop");
    expect(uris).toContain("boof://projects/shop/plans/q4");
    expect(uris).toContain(`boof://projects/shop/tasks/${taskId}`);
    const templates = (await admin.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate,
    );
    expect(templates).toContain("boof://projects/{pid}/tasks/{taskId}/log");
  });

  it("applies the same scope checks as the tools", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const client = await connect(await clientPrincipal(["tasks:read"], "review"));
    await expect(client.readResource({ uri: "boof://projects/shop" })).rejects.toThrow(
      /forbidden_scope/,
    );
  });

  it("resources/list degrades to an empty list for a key without the listing scopes", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const uris = async (client: Client) =>
      (await client.listResources()).resources.map((r) => r.uri).sort();
    const tasksOnly = await connect(await clientPrincipal(["tasks:read"], "review"));
    expect(await uris(tasksOnly)).toEqual(["boof://projects"]); // the static entry; its read is still refused
    await expect(tasksOnly.readResource({ uri: "boof://projects" })).rejects.toThrow(
      /forbidden_scope/,
    );
    const templates = (await tasksOnly.listResourceTemplates()).resourceTemplates;
    expect(templates.map((t) => t.uriTemplate)).toContain("boof://projects/{pid}/tasks/{taskId}");
    const projectsOnly = await connect(await clientPrincipal(["projects:read"], "review"));
    expect(await uris(projectsOnly)).toEqual(["boof://projects", "boof://projects/shop"]);
    const elsewhere = await connect(
      await clientPrincipal(["projects:read", "plans:read", "tasks:read"], "review", ["other"]),
    );
    expect(await uris(elsewhere)).toEqual(["boof://projects"]);
  });

  it("serves one project only when the project is fixed", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const client = await connect(LOCAL_PRINCIPAL, "shop");
    await expect(client.readResource({ uri: "boof://projects/other" })).rejects.toThrow(
      /forbidden_project/,
    );
  });
});

describe("prompts", () => {
  it("offers the planning and review prompts", async () => {
    const client = await connect(LOCAL_PRINCIPAL);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["boof_plan_project", "boof_review_plan"]);
    const planned = await client.getPrompt({
      name: "boof_plan_project",
      arguments: { goal: "Add checkout", projectId: "shop" },
    });
    const body = (planned.messages[0].content as { text: string }).text;
    expect(body).toContain("Add checkout");
    expect(body).toContain("boof_create_plan");
  });
});

describe("stdio principal", () => {
  it("uses the local principal only in local-trust mode", async () => {
    expect((await (await stdioPrincipal(services, authStore, { root }))()).kind).toBe("local");
    const settings = await services.loadSettings();
    await new SettingsStore(root).save({
      ...settings,
      security: {
        allowedHosts: [],
        auth: { mode: "required" },
        allowedProjectRoots: [],
        externalTasksRequireApproval: true,
        rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute: 30 },
        trustedProxies: ["loopback"],
        audit: { enabled: true, retentionDays: 90 },
      },
    });
    await expect(stdioPrincipal(services, authStore, { root })).rejects.toThrow(/--client/);
  });

  it("resolves --client from the registry and follows a revocation", async () => {
    const { client } = await authStore.create({
      name: "x",
      scopes: ["tasks:read"],
      trust: "review",
    });
    const resolve = await stdioPrincipal(services, authStore, { root, client: client.id });
    expect((await resolve()).id).toBe(client.id);
    await authStore.revoke(client.id);
    await expect(resolve()).rejects.toThrow(/revoked/);
    await expect(stdioPrincipal(services, authStore, { root, client: "nobody" })).rejects.toThrow(
      /unknown client/,
    );
  });

  it("refuses to start when settings.mcp.enabled is false", async () => {
    const settings = await services.loadSettings();
    await new SettingsStore(root).save({ ...settings, mcp: { enabled: false } });
    await expect(stdioPrincipal(services, authStore, { root })).rejects.toThrow(/disabled/);
  });
});

describe("warnings and structured reviews over MCP", () => {
  it("carries status_downgraded in structuredContent and appends the text", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);
    await call(admin, "boof_create_project", { workingDirectory: repo, id: "shop" });
    const reviewer = await connect(
      await clientPrincipal(["plans:write", "plans:read", "tasks:write", "tasks:read"], "review", [
        "shop",
      ]),
    );
    const plan = await call(reviewer, "boof_create_plan", {
      projectId: "shop",
      id: "q4",
      title: "Q4",
      status: "active",
      goals: [goal("a")],
    });
    expect(plan.structuredContent?.status).toBe("draft");
    expect(plan.structuredContent?.warnings).toEqual([
      expect.objectContaining({ code: "status_downgraded", requested: "active", applied: "draft" }),
    ]);
    expect(plan.content.map((c) => c.text).join("\n")).toContain("Warning (status_downgraded)");
    expect(plan.content[1]!.text.startsWith("{")).toBe(true);

    const task = await call(reviewer, "boof_create_task", {
      projectId: "shop",
      title: "Idea",
      status: "pending",
    });
    expect(task.structuredContent?.frontmatter.status).toBe("draft");
    expect(task.structuredContent?.warnings[0]).toMatchObject({
      field: "status",
      requested: "pending",
      applied: "draft",
    });
    expect(task.content.at(-1)!.text).toContain("Warning (status_downgraded)");

    const plain = await call(reviewer, "boof_create_task", { projectId: "shop", title: "Plain" });
    expect(plain.structuredContent).not.toHaveProperty("warnings");
    expect(plain.content).toHaveLength(2);
  });

  it("boof_get_task returns reviews, finalVerdict and branch after a run", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);
    await call(admin, "boof_create_project", { workingDirectory: repo, id: "shop" });
    await call(admin, "boof_create_plan", {
      projectId: "shop",
      id: "q4",
      title: "Q4",
      status: "active",
      goals: [goal("a")],
    });
    const sync = await call(admin, "boof_sync_plan", { projectId: "shop", planId: "q4" });
    const taskId = sync.structuredContent!.created[0].taskId as string;
    await new RunnerEngine({ root, pollIntervalMs: 10 }).runUntilIdle();
    const got = await call(admin, "boof_get_task", { projectId: "shop", taskId });
    expect(got.structuredContent?.frontmatter.status).toBe("done");
    expect(got.structuredContent?.branch).toBe(`boof-runner/${taskId}`);
    expect(got.structuredContent?.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(got.structuredContent?.finalVerdict.reviewer).toBe("APPROVE");
    expect(got.structuredContent?.reviews.at(-1)).toMatchObject({
      role: "reviewer",
      round: 1,
      iteration: 1,
      verdict: "APPROVE",
    });
  });
});

describe("closeWhenDrained", () => {
  const request = (id: number) => ({ jsonrpc: "2.0" as const, id, method: "tools/list" });
  const reply = (id: number) => ({ jsonrpc: "2.0" as const, id, result: {} });
  const cancel = (requestId: number) => ({
    jsonrpc: "2.0" as const,
    method: "notifications/cancelled",
    params: { requestId },
  });
  const setup = () => {
    const closes: number[] = [];
    const transport = {
      send: async () => {},
      onmessage: undefined as ((m: unknown) => void) | undefined,
    };
    const drain = closeWhenDrained(transport as never, () => closes.push(1));
    return { transport, drain, closes };
  };

  it("waits for the reply of a request received before stdin ended", async () => {
    const { transport, drain, closes } = setup();
    transport.onmessage?.(request(1));
    drain.stdinEnded();
    expect(closes).toEqual([]);
    await transport.send(reply(1) as never);
    expect(closes).toEqual([1]);
  });

  it("stops waiting for a request that was cancelled (the SDK sends no reply)", () => {
    const { transport, drain, closes } = setup();
    transport.onmessage?.(request(1));
    transport.onmessage?.(request(2));
    drain.stdinEnded();
    transport.onmessage?.(cancel(1));
    expect(closes).toEqual([]);
    transport.onmessage?.(cancel(2));
    expect(closes).toEqual([1]);
  });

  it("closes at once when stdin ends with nothing pending", () => {
    const { drain, closes } = setup();
    drain.stdinEnded();
    expect(closes).toEqual([1]);
  });
});

describe("handleMcpHttp", () => {
  it("a disconnected HTTP wait releases the handler", async () => {
    await services.projects.create({ workingDirectory: repo, id: "shop" });
    await call(await connect(LOCAL_PRINCIPAL), "boof_create_task", {
      projectId: "shop",
      title: "Idle",
      status: "pending",
    });
    let finished!: (info: ToolCallInfo) => void;
    const done = new Promise<ToolCallInfo>((r) => (finished = r));
    const ctrl = new AbortController();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "boof_wait_task",
        arguments: { projectId: "shop", taskId: "idle", timeoutSeconds: 30 },
      },
    });
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
      signal: ctrl.signal,
    });
    const started = Date.now();
    const pending = handleMcpHttp(request, {
      root,
      principal: LOCAL_PRINCIPAL,
      services,
      authStore,
      parsedBody: JSON.parse(body),
      onCall: finished,
    });
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await pending.catch(() => undefined); // the transport may reject once the request is aborted
    expect((await done).tool).toBe("boof_wait_task");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
