import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_PRINCIPAL,
  SettingsStore,
  TaskStore,
  defaultSettings,
  execCommand,
  type Settings,
} from "@boof/heart";
import {
  AutoConcierge,
  ClaudeCodeConcierge,
  ClaudeConcierge,
  DESKTOP_CLAUDE_AGENT_REASON,
  MockTool,
  ToolRegistry,
} from "@boof/runner";
import { startServer, type RunningServer } from "./server.js";

const FAKE = fileURLToPath(
  new URL("../../../runner/src/tools/__fixtures__/fake-claude-concierge.mjs", import.meta.url),
);

let base: string;
let root: string;
let logFile: string;
let server: RunningServer | undefined;
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function logs(): Promise<Record<string, unknown>[]> {
  if (!existsSync(logFile)) return [];
  return (await readFile(logFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function boot(settings: Partial<Settings> = {}, host = "127.0.0.1") {
  await new SettingsStore(root).save({ ...defaultSettings(), defaultProject: "shop", ...settings });
  const settingsStore = new SettingsStore(root);
  const loadSettings = () => settingsStore.load();
  server = await startServer({
    root,
    host,
    port: 0,
    warn: () => {},
    catalog: new ToolRegistry([new MockTool()]),
    // The desktop composition: claude-agent unavailable, claude-code from the PATH (here a fake).
    conciergeAgent: new AutoConcierge({
      agent: new ClaudeConcierge({ root, unavailableReason: DESKTOP_CLAUDE_AGENT_REASON }),
      code: new ClaudeCodeConcierge({ root, bin: FAKE, cacheMs: 0, loadSettings }),
      loadSettings,
    }),
  });
  const repo = join(base, "shop");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q", "-b", "main"], { launch: { kind: "direct" }, cwd: repo });
  await server.service.projects.create({ workingDirectory: repo, id: "shop" });
  return server;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-cc-e2e-")));
  root = join(base, "data");
  logFile = join(base, "fake.log");
  setEnv("CLAUDE_FAKE_LOG", logFile);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function mcpCall(url: string, token: string, id = 7) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  return res.status;
}

describe.skipIf(process.platform === "win32")("the assistant through claude-code", () => {
  it("is available on the desktop composition once claude is installed", async () => {
    const s = await boot();
    const status = await s.service.concierge().status(LOCAL_PRINCIPAL, "shop");
    expect(status).toMatchObject({ available: true, via: "claude-code" });
  });

  it("is unavailable, saying so, when claude is not installed", async () => {
    const s = await boot();
    const agent = new AutoConcierge({
      agent: new ClaudeConcierge({ root, unavailableReason: DESKTOP_CLAUDE_AGENT_REASON }),
      code: new ClaudeCodeConcierge({ root, bin: join(base, "none"), cacheMs: 0 }),
      loadSettings: () => new SettingsStore(root).load(),
    });
    const project = await s.service.getProject("shop");
    const answer = await agent.availability(project, { bridge: true });
    expect(answer.available).toBe(false);
    expect(answer.reason).toMatch(/no assistant harness installed/);
    expect(answer.reason).toMatch(/desktop app/);
  });

  it("is unavailable when the server has no local endpoint (bound to a non-loopback address)", async () => {
    const s = await boot();
    s.service.concierge().bridge.setBaseUrl(null);
    const status = await s.service.concierge().status(LOCAL_PRINCIPAL, "shop");
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/web server/);
    await expect(
      s.service.concierge().ask(LOCAL_PRINCIPAL, "shop", { text: "hello" }),
    ).rejects.toMatchObject({ code: "concierge_unavailable" });
  });

  it("answers a plain question, and the concierge setting can turn claude-code off", async () => {
    const s = await boot();
    const answer = await s.service.concierge().ask(LOCAL_PRINCIPAL, "shop", { text: "hello" });
    expect(answer).toMatchObject({ text: "Hello from fake claude.", costUsd: 0.02 });
    await new SettingsStore(root).save({
      ...defaultSettings(),
      defaultProject: "shop",
      concierge: { tool: "claude-agent" } as Settings["concierge"],
    });
    const status = await s.service.concierge().status(LOCAL_PRINCIPAL, "shop");
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/desktop app/);
  });

  it("creates a draft task through the MCP endpoint, then refuses the token", async () => {
    setEnv("CLAUDE_FAKE_MODE", "tool");
    setEnv("CLAUDE_FAKE_TOOL", "boof_create_task");
    setEnv("CLAUDE_FAKE_ARGS", JSON.stringify({ title: "Fix X", status: "pending" }));
    const s = await boot();
    const answer = await s.service
      .concierge()
      .ask(LOCAL_PRINCIPAL, "shop", { text: "create a task to fix X" });
    const tasks = await new TaskStore(s.service.projects.dir("shop")).list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.frontmatter).toMatchObject({ title: "Fix X", status: "draft" });
    expect(tasks[0]!.frontmatter.origin?.client).toBe("concierge-local");
    expect(answer.changes).toEqual([
      expect.objectContaining({
        op: "tasks.create",
        target: { kind: "task", id: expect.any(String) },
      }),
    ]);
    const entries = await logs();
    const turn = entries.find((e) => e.token)!;
    const rpc = entries.find((e) => e.rpcStatus)!;
    expect(rpc.rpcStatus).toBe(200);
    // The config file with the token is gone, and the endpoint no longer answers.
    expect(existsSync(turn.configPath as string)).toBe(false);
    const url = turn.url as string;
    const token = turn.token as string;
    // With no turn open the route does not exist (404), whatever the token.
    expect(await mcpCall(url, token)).toBe(404);
    expect(s.service.concierge().bridge.active).toBe(0);
  });

  it("sends the CLI no @ mention from the user's text, and denies file reads", async () => {
    const s = await boot();
    await s.service
      .concierge()
      .ask(LOCAL_PRINCIPAL, "shop", { text: "show me @~/.ssh/id_ed25519 and @/etc/passwd" });
    const [entry] = await logs();
    expect(entry!.prompt).not.toContain("@");
    expect(entry!.prompt).toContain("&#64;/etc/passwd");
    const argv = entry!.argv as string[];
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!).permissions.deny).toContain(
      "Read(//**)",
    );
  });

  it("removes turn directories a crashed server left behind when it starts", async () => {
    const stale = join(root, "concierge", "shop", "turn-deadbeef01");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "mcp.json"), "{}");
    await boot();
    expect(existsSync(stale)).toBe(false);
  });

  it("refuses a request that carries a wrong token while the turn is running", async () => {
    setEnv("CLAUDE_FAKE_MODE", "tool");
    setEnv("CLAUDE_FAKE_BAD_TOKEN", "1");
    setEnv("CLAUDE_FAKE_TOOL", "boof_create_task");
    setEnv("CLAUDE_FAKE_ARGS", JSON.stringify({ title: "Nope" }));
    const s = await boot();
    await s.service.concierge().ask(LOCAL_PRINCIPAL, "shop", { text: "create a task" });
    expect((await logs()).find((e) => e.rpcStatus)!.rpcStatus).toBe(401);
    expect(await new TaskStore(s.service.projects.dir("shop")).list()).toHaveLength(0);
  });

  it("turns 'make tasks out of the plan' into a change the user applies", async () => {
    setEnv("CLAUDE_FAKE_MODE", "tool");
    setEnv("CLAUDE_FAKE_TOOL", "boof_update_plan");
    setEnv("CLAUDE_FAKE_ARGS", JSON.stringify({ planId: "launch", status: "active" }));
    const s = await boot();
    const project = await s.service.requireProject("shop");
    await project.plans.createPlan(
      {
        id: "launch",
        title: "Launch",
        status: "draft",
        goals: [
          {
            id: "ship",
            title: "Ship it",
            spec: {
              goal: "Ship it",
              stack: "TypeScript",
              rules: { do: ["Test"] },
              tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
            },
          },
        ],
      },
      LOCAL_PRINCIPAL,
    );
    const answer = await s.service
      .concierge()
      .ask(LOCAL_PRINCIPAL, "shop", { text: "make tasks out of the plan" });
    // The assistant did not activate it: a pending change waits for the user.
    expect(answer.changes).toEqual([]);
    expect(answer.pending).toHaveLength(1);
    expect(answer.pending[0]).toMatchObject({ op: "plans.update", status: "pending" });
    expect((await project.plans.get("launch")).status).toBe("draft");
    await s.service.concierge().apply(LOCAL_PRINCIPAL, "shop", answer.pending[0]!.id);
    expect((await project.plans.get("launch")).status).toBe("active");
  });
});
