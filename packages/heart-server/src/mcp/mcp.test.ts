import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AuthStore,
  authorize,
  BOOF_VERSION,
  defaultSettings,
  LOCAL_PRINCIPAL,
  SCOPES,
  SecuritySettingsSchema,
  SettingsStore,
  type Principal,
  type Scope,
  execCommand,
} from "@boof/heart";
import { registry } from "../api/index.js";
import { resetMock, RunnerEngine, MockTool, ToolRegistry } from "@boof/runner";
import { TaskService } from "../api/index.js";
import {
  closeWhenDrained,
  createBoofMcpServer,
  createConciergeMcpServer,
  handleMcpHttp,
  exposedOps,
  McpStartError,
  principalFromClient,
  stdioAudit,
  stdioPrincipal,
  type BoofMcpOptions,
  type ToolCallInfo,
} from "./index.js";
import {
  CONCIERGE_TOOLS,
  conciergeCanList,
  conciergeOps,
  conciergePrincipal,
} from "../concierge/policy.js";

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

// Fixed on purpose (not derived from the registry): the tools of a client made with the printed
// recipe. No administration tool; boof_delete_project is listed and refused at call time.
const EXPECTED_REVIEW_TOOLS: string[] = [
  "boof_answer_task",
  "boof_archive_project",
  "boof_archive_task",
  "boof_create_epic",
  "boof_create_plan",
  "boof_create_project",
  "boof_create_task",
  "boof_delete_epic",
  "boof_delete_project",
  "boof_delete_task",
  "boof_export_plan",
  "boof_get_agent_sdk_eligibility",
  "boof_get_budget",
  "boof_get_epic",
  "boof_get_health",
  "boof_get_model_details",
  "boof_get_plan",
  "boof_get_pool_health",
  "boof_get_project",
  "boof_get_project_usage",
  "boof_get_runner",
  "boof_get_settings",
  "boof_get_task",
  "boof_get_task_diff",
  "boof_get_task_log",
  "boof_get_usage",
  "boof_import_plan",
  "boof_inject_prompt",
  "boof_list_accounts",
  "boof_list_actions",
  "boof_list_commands",
  "boof_list_epics",
  "boof_list_models",
  "boof_list_plans",
  "boof_list_projects",
  "boof_list_tasks",
  "boof_move_task",
  "boof_pause_project",
  "boof_queue_task",
  "boof_refresh_models",
  "boof_remove_attachment",
  "boof_remove_goal",
  "boof_reorder_goals",
  "boof_reorder_tasks",
  "boof_replace_goals",
  "boof_resume_project",
  "boof_retry_task",
  "boof_runner_status",
  "boof_set_goal_status",
  "boof_set_runner",
  "boof_skip_task",
  "boof_stop_task",
  "boof_sync_plan",
  "boof_unarchive_project",
  "boof_unarchive_task",
  "boof_update_epic",
  "boof_update_plan",
  "boof_update_project",
  "boof_update_task",
  "boof_upsert_goal",
  "boof_wait_plan",
  "boof_wait_task",
  "boof_whoami",
];

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
  services = new TaskService(root, new ToolRegistry([new MockTool()]));
  authStore = new AuthStore(root);
  resetMock();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

describe("tools generated from the registry", () => {
  it("boof_create_project takes path and brief; the tool schema lists the three modes", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);
    const tool = (await admin.listTools()).tools.find((t) => t.name === "boof_create_project")!;
    expect(JSON.stringify(tool.inputSchema)).toContain('"auto"');
    const res = await call(admin, "boof_create_project", {
      path: { mode: "new", directory: join(base, "fresh") },
      brief: "Fresh",
    });
    expect(res.structuredContent).toMatchObject({
      id: "fresh",
      brief: "Fresh",
      workingDirectory: join(base, "fresh"),
    });
  });

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
        "boof_archive_project",
        "boof_unarchive_project",
        "boof_pause_project",
        "boof_resume_project",
        "boof_delete_project",
        "boof_get_project_usage",
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
        "boof_move_task",
        "boof_queue_task",
        "boof_skip_task",
        "boof_reorder_tasks",
        "boof_retry_task",
        "boof_archive_task",
        "boof_unarchive_task",
        "boof_delete_task",
        "boof_answer_task",
        "boof_stop_task",
        "boof_inject_prompt",
        "boof_get_task_log",
        "boof_wait_task",
        "boof_remove_attachment",
        "boof_list_epics",
        "boof_get_epic",
        "boof_create_epic",
        "boof_update_epic",
        "boof_delete_epic",
        "boof_get_settings",
        "boof_update_settings",
        "boof_get_health",
        "boof_check_health",
        "boof_list_models",
        "boof_refresh_models",
        "boof_get_model_details",
        "boof_get_usage",
        "boof_get_budget",
        "boof_get_runner",
        "boof_runner_status",
        "boof_set_runner",
        "boof_list_actions",
        "boof_list_commands",
        "boof_create_command",
        "boof_update_command",
        "boof_delete_command",
        "boof_list_clients",
        "boof_create_client",
        "boof_revoke_client",
        "boof_rotate_client",
        "boof_list_accounts",
        "boof_get_agent_sdk_eligibility",
        "boof_get_pool_health",
        "boof_pause_account",
        "boof_resume_account",
        "boof_set_account_priority",
        "boof_set_account_thresholds",
        "boof_list_webhooks",
        "boof_create_webhook",
        "boof_update_webhook",
        "boof_delete_webhook",
      ]
    `);
    // Every exposed JSON operation except file upload and download. Concierge is REST/CLI only.
    const jsonOps = (await import("../api/index.js")).registry.filter(
      (o) => (!o.rest.kind || o.rest.kind === "json") && o.mcp.expose,
    );
    expect(names).toHaveLength(jsonOps.length);
    expect(names).toHaveLength(80);
    const scopesByTool = Object.fromEntries(
      exposedOps(await import("../api/index.js").then((m) => m.registry)).map((o) => [
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
      boof_get_agent_sdk_eligibility: "settings:read",
      boof_set_runner: "runner:control|settings:write",
      boof_revoke_client: "auth:admin",
      boof_create_webhook: "admin",
      boof_update_settings: "settings:write",
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

  it("the local principal lists the administration tools, but not the file transfer", async () => {
    const names = (await (await connect(LOCAL_PRINCIPAL)).listTools()).tools.map((t) => t.name);
    for (const n of [
      "boof_create_client",
      "boof_revoke_client",
      "boof_rotate_client",
      "boof_list_webhooks",
      "boof_create_webhook",
      "boof_update_settings",
      "boof_create_command",
      "boof_delete_project",
    ]) {
      expect(names, n).toContain(n);
    }
    expect(names.filter((n) => /attachment/.test(n))).toEqual(["boof_remove_attachment"]);
  });

  it("a tasks:read client sees no administration tool and is refused if it calls one", async () => {
    const reader = await connect(await clientPrincipal(["tasks:read"], "trusted"));
    const names = (await reader.listTools()).tools.map((t) => t.name);
    for (const n of [
      "boof_create_client",
      "boof_list_clients",
      "boof_list_webhooks",
      "boof_update_settings",
      "boof_create_command",
    ]) {
      expect(names, n).not.toContain(n);
    }
    const res = await call(reader, "boof_revoke_client", { clientId: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.startsWith("forbidden_scope:")).toBe(true);
  });

  it("a review client with auth:admin cannot mint a trusted or wider client over MCP", async () => {
    const rev = await connect(await clientPrincipal(["auth:admin", "tasks:read"], "review"));
    const trusted = await call(rev, "boof_create_client", {
      name: "x",
      scopes: ["tasks:read"],
      trust: "trusted",
    });
    expect(trusted.content[0].text.startsWith("forbidden_trust:")).toBe(true);
    const wide = await call(rev, "boof_create_client", { name: "y", scopes: ["admin"] });
    expect(wide.content[0].text.startsWith("forbidden_scope:")).toBe(true);
  });

  it("boof_create_client returns the key in the result, not in the summary", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);
    const res = await call(admin, "boof_create_client", { name: "bot", scopes: ["tasks:read"] });
    expect(res.isError).toBeFalsy();
    const key = res.structuredContent!.key as string;
    expect(key).toMatch(/^boof_/);
    expect(res.content[0].text).not.toContain(key);
    expect(res.content[0].text).toContain("shown only once");
  });

  it("boof_create_webhook refuses a loopback target over MCP", async () => {
    const admin = await connect(LOCAL_PRINCIPAL);
    const res = await call(admin, "boof_create_webhook", { url: "http://127.0.0.1:9/hook" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("127.0.0.1");
  });

  it("a server fixed to one project hides server administration tools", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const names = (await (await connect(LOCAL_PRINCIPAL, "shop")).listTools()).tools.map(
      (t) => t.name,
    );
    for (const n of [
      "boof_list_clients",
      "boof_create_client",
      "boof_revoke_client",
      "boof_rotate_client",
      "boof_list_webhooks",
      "boof_create_webhook",
      "boof_delete_webhook",
    ]) {
      expect(names, n).not.toContain(n);
    }
    for (const n of ["boof_whoami", "boof_update_settings", "boof_set_runner"]) {
      expect(names, n).toContain(n);
    }
  });

  it("a server fixed to one project narrows the principal, not only the tool list", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const other = join(repo, "..", "boof-mcp-other");
    await mkdir(other, { recursive: true });
    await execCommand("git", ["init", "-q"], { cwd: other });
    await services.createProject({ workingDirectory: other, id: "other" }, LOCAL_PRINCIPAL);
    try {
      const pinned = await connect(LOCAL_PRINCIPAL, "shop");
      const list = await call(pinned, "boof_list_projects");
      expect(list.structuredContent?.projects.map((p: { id: string }) => p.id)).toEqual(["shop"]);
      const whoami = await call(pinned, "boof_whoami");
      expect(JSON.stringify(whoami.structuredContent)).not.toContain("other");
      // Resources cannot reach the other project either.
      const all = await connect(LOCAL_PRINCIPAL);
      expect(
        (await call(all, "boof_list_projects")).structuredContent?.projects.length,
      ).toBeGreaterThan(1);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "a review-trust client cannot archive, unarchive or purge a project over MCP (approval setting %s)",
    async (approvalRequired) => {
      const settings = await new SettingsStore(root).load();
      settings.security = SecuritySettingsSchema.parse({
        externalTasksRequireApproval: approvalRequired,
      });
      await new SettingsStore(root).save(settings);
      await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
      const rev = await connect(
        await clientPrincipal(["projects:write", "projects:read"], "review"),
      );
      // Archiving and unarchiving are refused whatever the approval setting says.
      for (const [tool, args] of [
        ["boof_archive_project", { projectId: "shop" }],
        ["boof_unarchive_project", { projectId: "shop" }],
        ["boof_delete_project", { projectId: "shop", purge: true }],
        ["boof_delete_project", { projectId: "shop" }],
      ] as const) {
        const res = await call(rev, tool, args);
        expect(res.isError, tool).toBe(true);
        expect(res.content[0].text.startsWith("forbidden_trust:"), tool).toBe(true);
      }
      expect((await services.getProject("shop")).archived).toBe(false);
    },
  );

  it.each([true, false])(
    "a trusted client can still archive and unarchive a project over MCP (approval setting %s)",
    async (approvalRequired) => {
      const settings = await new SettingsStore(root).load();
      settings.security = SecuritySettingsSchema.parse({
        externalTasksRequireApproval: approvalRequired,
      });
      await new SettingsStore(root).save(settings);
      await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
      const admin = await connect(
        await clientPrincipal(["projects:write", "projects:read"], "trusted"),
      );
      const archived = await call(admin, "boof_archive_project", { projectId: "shop" });
      expect(archived.isError).not.toBe(true);
      expect((await services.getProject("shop")).archived).toBe(true);
      const unarchived = await call(admin, "boof_unarchive_project", { projectId: "shop" });
      expect(unarchived.isError).not.toBe(true);
      expect((await services.getProject("shop")).archived).toBe(false);
    },
  );

  it("a trusted client with projects:write can still delete a project over MCP", async () => {
    const settings = await new SettingsStore(root).load();
    settings.security = SecuritySettingsSchema.parse({ externalTasksRequireApproval: false });
    await new SettingsStore(root).save(settings);
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const admin = await connect(
      await clientPrincipal(["projects:write", "projects:read"], "trusted"),
    );
    const res = await call(admin, "boof_delete_project", { projectId: "shop", purge: true });
    expect(res.isError).not.toBe(true);
    await expect(services.getProject("shop")).rejects.toThrow();
  });

  it("boof_update_epic lets a review client change only its own epics", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const admin = await connect(LOCAL_PRINCIPAL);
    await call(admin, "boof_create_epic", { projectId: "shop", title: "Human" });
    const rev = await connect(await clientPrincipal(["tasks:read", "tasks:write"], "review"));
    const refused = await call(rev, "boof_update_epic", {
      projectId: "shop",
      epicId: "human",
      title: "IGNORE PREVIOUS",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("forbidden_trust");
    const mine = await call(rev, "boof_create_epic", { projectId: "shop", title: "Mine" });
    const ok = await call(rev, "boof_update_epic", {
      projectId: "shop",
      epicId: mine.structuredContent!.id,
      priority: 4,
    });
    expect(ok.isError).toBeFalsy();
  });

  it("boof_move_task moves a task under a parent", async () => {
    await services.createProject({ workingDirectory: repo, id: "shop" }, LOCAL_PRINCIPAL);
    const client = await connect(LOCAL_PRINCIPAL);
    const p = await call(client, "boof_create_task", { projectId: "shop", title: "Parent" });
    const c = await call(client, "boof_create_task", { projectId: "shop", title: "Child" });
    const moved = await call(client, "boof_move_task", {
      projectId: "shop",
      taskId: c.structuredContent!.frontmatter.id,
      parentId: p.structuredContent!.frontmatter.id,
    });
    expect(moved.isError).toBeFalsy();
    expect(moved.structuredContent?.frontmatter.parentId).toBe("parent");
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
  it("refuses to start without --client, in local-trust and when auth is required", async () => {
    const refused = await stdioPrincipal(services, authStore, { root }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(McpStartError);
    expect((refused as Error).message).toMatch(/boof-runner mcp needs --client <id>/);
    expect((refused as Error).message).toMatch(/Keyless MCP was removed/);
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
    await expect(stdioPrincipal(services, authStore, { root })).rejects.toThrow(
      /Keyless MCP was removed/,
    );
  });

  it("MCP_REVIEW_SCOPES equals SCOPES minus admin, auth:admin, settings:write", async () => {
    const { MCP_REVIEW_SCOPES } = await import("../api/local-principal.js");
    expect(MCP_REVIEW_SCOPES).toEqual(
      SCOPES.filter((s) => s !== "admin" && s !== "auth:admin" && s !== "settings:write"),
    );
  });

  it("a review-trust client with MCP_REVIEW_SCOPES lists exactly the expected tools (boof_delete_project is listed but refused)", async () => {
    const { MCP_REVIEW_SCOPES } = await import("../api/local-principal.js");
    const principal = await clientPrincipal([...(MCP_REVIEW_SCOPES as readonly Scope[])], "review");
    const listed = (await (await connect(principal)).listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(EXPECTED_REVIEW_TOOLS);
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
    const { client } = await authStore.create({
      name: "x",
      scopes: ["tasks:read"],
      trust: "review",
    });
    const settings = await services.loadSettings();
    await new SettingsStore(root).save({ ...settings, mcp: { enabled: false } });
    await expect(stdioPrincipal(services, authStore, { root, client: client.id })).rejects.toThrow(
      /disabled/,
    );
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

  describe("stdio audit", () => {
    const auditLines = async () => {
      const dir = join(root, "audit");
      const files = await readdir(dir).catch(() => []);
      return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8"))))
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    };

    it("every tool call appends one audit line: who, tool, project, outcome; no arguments", async () => {
      const auditor = stdioAudit(root);
      const agent = await clientPrincipal(
        ["tasks:read", "tasks:write", "projects:read"],
        "trusted",
      );
      const c = await connect(agent, undefined, { onCall: auditor.onCall });
      await call(c, "boof_create_project", {
        path: { mode: "new", directory: join(base, "a") },
        brief: "SECRET-BRIEF",
      });
      await call(c, "boof_create_task", { projectId: "nope", title: "T", prompt: "SECRET-PROMPT" });
      await auditor.flush();
      const lines = await auditLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        principal: agent.id,
        kind: "client",
        action: "mcp:boof_create_project",
        via: "stdio-mcp",
      });
      expect(lines[1]).toMatchObject({
        action: "mcp:boof_create_task",
        project: "nope",
        outcome: "error",
      });
      expect(typeof lines[1]!.error).toBe("string");
      expect(typeof lines[1]!.ms).toBe("number");
      expect(JSON.stringify(lines)).not.toMatch(/SECRET/);
    });

    it("a review client's call is recorded under its name, a refusal as an error", async () => {
      const auditor = stdioAudit(root);
      const { MCP_REVIEW_SCOPES } = await import("../api/local-principal.js");
      const reviewer = await clientPrincipal([...MCP_REVIEW_SCOPES], "review");
      const c = await connect(reviewer, undefined, { onCall: auditor.onCall });
      await call(c, "boof_set_runner", { enabled: true });
      await auditor.flush();
      expect(await auditLines()).toMatchObject([
        {
          principal: reviewer.name,
          action: "mcp:boof_set_runner",
          via: "stdio-mcp",
          outcome: "error",
          error: "forbidden_trust",
        },
      ]);
    });

    it("writes nothing when security.audit.enabled is false", async () => {
      const settings = await services.loadSettings();
      await new SettingsStore(root).save({
        ...settings,
        security: { ...settings.security, audit: { enabled: false, retentionDays: 90 } },
      });
      const auditor = stdioAudit(root);
      const c = await connect(LOCAL_PRINCIPAL, undefined, { onCall: auditor.onCall });
      await call(c, "boof_list_projects", {});
      await auditor.flush();
      expect(await auditLines()).toEqual([]);
    });
  });
});

describe("MCP call gates", () => {
  it("builds the concierge MCP surface with only its pinned allowlist", async () => {
    const server = createConciergeMcpServer({
      root,
      principal: conciergePrincipal(LOCAL_PRINCIPAL, "shop"),
      services,
      authStore,
      project: "shop",
      gate: {},
      listable: (op) =>
        conciergeCanList(op, conciergePrincipal(LOCAL_PRINCIPAL, "shop"), LOCAL_PRINCIPAL, "shop"),
    });
    const client = new Client({ name: "concierge-wrapper", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    open.push(client);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(Object.keys(CONCIERGE_TOOLS).length);
    expect(tools.tools.some((tool) => tool.name === "boof_delete_task_diff")).toBe(false);
    expect(
      tools.tools.find((tool) => tool.name === "boof_create_task")?.inputSchema.properties,
    ).not.toHaveProperty("projectId");
    const update = tools.tools.find((tool) => tool.name === "boof_update_project");
    expect(Object.keys(update?.inputSchema.properties ?? {})).toEqual(["brief"]);
    expect(update?.inputSchema.required).toEqual(["brief"]);
    expect(update?.description).toContain("description (brief)");
    await expect(client.listPrompts()).rejects.toThrow();
  });

  it("never lets the assistant's principal change the project, by tool call or direct op", async () => {
    await services.projects.create({ workingDirectory: repo, id: "shop" });
    const assistant = conciergePrincipal(LOCAL_PRINCIPAL, "shop");
    expect(assistant.scopes.has("projects:write")).toBe(false);
    // Even with no gate at all, the call runs under the assistant's principal and is refused.
    const server = createConciergeMcpServer({
      root,
      principal: assistant,
      services,
      authStore,
      project: "shop",
      gate: {},
    });
    const client = new Client({ name: "concierge-direct", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    open.push(client);
    expect((await client.listTools()).tools.some((t) => t.name === "boof_update_project")).toBe(
      false,
    );
    for (const args of [{ paused: true }, { name: "Renamed" }, { brief: "x" }]) {
      const result = await client.callTool({ name: "boof_update_project", arguments: args });
      expect(result.isError).toBe(true);
    }
    for (const [name, input] of [
      ["projects.update", { projectId: "shop", paused: true }],
      ["projects.update", { projectId: "shop", name: "Renamed" }],
      ["projects.update", { projectId: "shop", brief: "x" }],
      ["projects.pause", { projectId: "shop" }],
    ] as const) {
      const op = registry.find((o) => o.name === name)!;
      await expect(
        op.execute(
          { root, principal: assistant, services, authStore, now: () => new Date().toISOString() },
          input,
        ),
      ).rejects.toMatchObject({ code: "forbidden_scope" });
    }
    const project = await services.getProject("shop");
    expect(project.paused).toBe(false);
    expect(project.name).not.toBe("Renamed");
  });

  it("lets a before answer replace a destructive call without running it", async () => {
    await services.projects.create({ workingDirectory: repo, id: "shop" });
    await call(await connect(LOCAL_PRINCIPAL), "boof_create_task", {
      projectId: "shop",
      title: "Keep me",
      status: "pending",
    });
    const client = await connect(LOCAL_PRINCIPAL, "shop", {
      ops: registry,
      gate: {
        before: async (op) =>
          op.name === "tasks.delete"
            ? { summary: "Deletion needs your confirmation.", structured: { pending: true } }
            : undefined,
      },
    });

    const listed = await client.listTools();
    expect(
      listed.tools.find((tool) => tool.name === "boof_delete_task")?.outputSchema,
    ).toBeUndefined();

    const result = await call(client, "boof_delete_task", { taskId: "keep-me" });
    expect(result.content[0]?.text).toBe("Deletion needs your confirmation.");
    expect(result.content[1]?.text).toBe('{"pending":true}');
    expect(result.structuredContent).toEqual({ pending: true });
    expect(
      (await call(client, "boof_get_task", { taskId: "keep-me" })).structuredContent?.frontmatter,
    ).toMatchObject({ id: "keep-me" });
  });

  it("maps a refused error through the hook and leaves other errors unchanged", async () => {
    await services.projects.create({ workingDirectory: repo, id: "shop" });
    await call(await connect(LOCAL_PRINCIPAL), "boof_create_task", {
      projectId: "shop",
      title: "Review delete",
      status: "pending",
    });
    const review = await clientPrincipal(["tasks:read", "tasks:write"], "review");
    const client = await connect(review, "shop", {
      ops: registry,
      gate: {
        refused: async (_op, _raw, err) =>
          err.code === "forbidden_trust"
            ? { summary: "This action needs your confirmation.", structured: { pending: true } }
            : undefined,
      },
    });

    const refused = await call(client, "boof_delete_task", { taskId: "review-delete" });
    expect(refused.isError).not.toBe(true);
    expect(refused.content[0]?.text).toBe("This action needs your confirmation.");
    const missing = await call(client, "boof_get_task", { taskId: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("not_found");
  });

  it("lets after replace a successful operation result", async () => {
    const client = await connect(LOCAL_PRINCIPAL, undefined, {
      ops: registry,
      gate: { after: async (_op, _raw, result) => ({ ...(result as object), replaced: true }) },
    });
    const result = await call(client, "boof_list_projects", {});
    expect(result.structuredContent).toMatchObject({ replaced: true, projects: [] });
  });

  it("can disable resources and prompts", async () => {
    const client = await connect(LOCAL_PRINCIPAL, undefined, { resources: false });
    await expect(client.listResources()).rejects.toThrow();
    await expect(client.listResourceTemplates()).rejects.toThrow();
    await expect(client.listPrompts()).rejects.toThrow();
  });

  it("uses custom server instructions", async () => {
    const client = await connect(LOCAL_PRINCIPAL, undefined, {
      ops: registry,
      instructions: "Only use the project tools provided.",
    });
    expect(client.getInstructions()).toBe("Only use the project tools provided.");
  });

  it("reports successful gate answers in the call audit", async () => {
    const calls: ToolCallInfo[] = [];
    const client = await connect(LOCAL_PRINCIPAL, undefined, {
      ops: registry,
      onCall: (info) => calls.push(info),
      gate: {
        before: async () => ({ summary: "Gated", structured: { gated: true } }),
      },
    });
    await call(client, "boof_list_projects", {});
    expect(calls[0]).toMatchObject({ ok: true, gated: true });
  });

  it("keeps gate hook failures from misreporting or retrying an operation", async () => {
    const refusedCalls: string[] = [];
    const before = await connect(LOCAL_PRINCIPAL, undefined, {
      ops: registry,
      gate: {
        before: async () => {
          throw new Error("before failed");
        },
        refused: async () => {
          refusedCalls.push("called");
          return undefined;
        },
      },
    });
    const beforeResult = await call(before, "boof_list_projects", {});
    expect(beforeResult.isError).toBe(true);
    expect(beforeResult.content[0]?.text).toContain("Internal error");
    expect(refusedCalls).toEqual([]);

    const after = await connect(LOCAL_PRINCIPAL, undefined, {
      ops: registry,
      gate: {
        after: async () => {
          throw new Error("after failed");
        },
      },
    });
    const afterResult = await call(after, "boof_list_projects", {});
    expect(afterResult.isError).not.toBe(true);
    expect(afterResult.structuredContent).toEqual({ projects: [] });

    const refused = await connect(LOCAL_PRINCIPAL, undefined, {
      ops: registry,
      gate: {
        before: async () => undefined,
        refused: async () => {
          throw new Error("refused hook failed");
        },
      },
    });
    const refusedResult = await call(refused, "boof_get_task", {
      projectId: "shop",
      taskId: "missing",
    });
    expect(refusedResult.isError).toBe(true);
    expect(refusedResult.content[0]?.text).toContain("not_found");
  });

  it.each([true, false])(
    "concierge write behavior stays restricted with external approval setting %s",
    async (approvalRequired) => {
      const settings = await new SettingsStore(root).load();
      settings.security = SecuritySettingsSchema.parse({
        externalTasksRequireApproval: approvalRequired,
      });
      await new SettingsStore(root).save(settings);
      await services.projects.create({ workingDirectory: repo, id: "shop" });
      await call(await connect(LOCAL_PRINCIPAL), "boof_create_task", {
        projectId: "shop",
        title: "Human task",
        status: "pending",
      });
      const concierge = conciergePrincipal(LOCAL_PRINCIPAL, "shop");
      const client = await connect(concierge, "shop", {
        ops: conciergeOps(registry),
        gate: {
          refused: async (_op, _raw, err) =>
            err.code === "forbidden_trust"
              ? { summary: "Waiting for confirmation", structured: { pending: true } }
              : undefined,
        },
      });
      const listed = await client.listTools();
      expect(
        listed.tools.find((tool) => tool.name === "boof_create_task")?.outputSchema,
      ).toBeUndefined();
      const created = await call(client, "boof_create_task", {
        title: "Assistant task",
        status: "pending",
      });
      expect(created.structuredContent?.frontmatter.status).toBe("draft");
      const humanUpdate = await call(client, "boof_update_task", {
        taskId: "human-task",
        prompt: "EVIL PROMPT",
      });
      expect(humanUpdate.content[0]?.text).toBe("Waiting for confirmation");
      expect(humanUpdate.isError).not.toBe(true);
      const saved = await call(await connect(LOCAL_PRINCIPAL, "shop"), "boof_get_task", {
        taskId: "human-task",
      });
      expect(saved.structuredContent?.frontmatter.prompt).not.toBe("EVIL PROMPT");
      const plan = await call(client, "boof_create_plan", {
        title: "Assistant plan",
        status: "active",
      });
      expect(plan.structuredContent?.status).toBe("draft");
    },
  );
});
