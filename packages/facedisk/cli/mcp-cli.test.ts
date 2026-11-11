import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockTool, ToolRegistry } from "@boof/runner";
import { AuthStore, SCOPES, type Scope } from "@boof/heart";
import { mcpCommand, MCP_HELP } from "./mcp-cli.js";

/** The scopes a review-trust MCP host is told to request: every scope except the administrator's. */
const REVIEW_SCOPES = SCOPES.filter(
  (s) => s !== "admin" && s !== "auth:admin" && s !== "settings:write",
);

const CLIENT_REQUIRED = [
  "boof-runner mcp needs --client <id>. Keyless MCP was removed (agent containment).",
  "Create a review-trust client once, then use it:",
  `  boof-runner auth add --name mcp-host --scopes ${REVIEW_SCOPES.join(",")} --trust review`,
  "  boof-runner mcp --client <the printed id> [--project <id>]",
  "For the administration tools, create a trusted client with the admin scope instead.",
].join("\n");

const ADMIN_REMOVED =
  'boof-runner mcp: --admin was removed. Create a trusted client with the admin scope ("boof-runner auth add --name mcp-admin --scopes admin --trust trusted") and pass --client <id>.';

const here = dirname(fileURLToPath(import.meta.url));
// This integration test spawns bin; test files are outside the production boundary check.
const entry = join(here, "..", "..", "..", "bin", "src", "boof-runner.ts");
const tsx = join(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-mcp-stdio-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const line = (m: unknown) => JSON.stringify(m) + "\n";
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};

/** A child never inherits this process's environment (no gateway, no boof credential). */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: root,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "C.UTF-8",
  };
}

async function makeClient(opts: {
  name: string;
  scopes: Scope[];
  trust: "trusted" | "review";
}): Promise<string> {
  const { client } = await new AuthStore(root).create(opts);
  return client.id;
}

/** Spawn `boof-runner mcp`, send `lines`, close stdin and collect everything. */
function runMcp(args: string[], lines: unknown[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(tsx, [entry, "mcp", "-d", root, ...args], {
      stdio: "pipe",
      env: childEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // Close stdin straight after the requests: the server must still answer every one of them.
    for (const m of lines) child.stdin.write(line(m));
    child.stdin.end();
  });
}

describe("boof-runner mcp over stdio", () => {
  it("answers initialize and tools/list; stdout carries only JSON-RPC", async () => {
    const id = await makeClient({ name: "host", scopes: ["admin"], trust: "trusted" });
    const res = await runMcp(
      ["--client", id],
      [
        INIT,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "boof_list_projects", arguments: {} },
        },
      ],
    );
    const out = res.stdout.split("\n").filter(Boolean);
    expect(out.length).toBe(3);
    const msgs = out.map((l) => JSON.parse(l)); // every stdout line must parse as JSON
    for (const m of msgs) expect(m.jsonrpc).toBe("2.0");
    expect(msgs[0].result.serverInfo.name).toBe("boof-runner");
    const names = msgs[1].result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("boof_create_plan");
    expect(msgs[2].result.structuredContent.projects).toEqual([]);
    expect(res.stderr).toContain("boof-runner mcp: serving");
    expect(res.stderr).not.toContain('"jsonrpc"');
  }, 30000);

  const toolNames = async (args: string[]) => {
    const res = await runMcp(args, [
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))[1]
      .result.tools.map((t: { name: string }) => t.name) as string[];
  };

  it("mcp --client <id> serves; --project still pins and hides the client/webhook tools", async () => {
    const id = await makeClient({ name: "boss", scopes: ["admin"], trust: "trusted" });
    const unpinned = await toolNames(["--client", id]);
    expect(unpinned).toContain("boof_create_client");
    expect(unpinned).toContain("boof_create_webhook");

    const { ProjectStore, execCommand } = await import("@boof/heart");
    const base = await mkdtemp(join(tmpdir(), "boof-mcp-pin-"));
    const repoDir = join(base, "repo");
    await mkdir(repoDir, { recursive: true });
    await execCommand("git", ["init", "-q"], { launch: { kind: "direct" }, cwd: repoDir });
    await new ProjectStore(root).create({ workingDirectory: repoDir, id: "shop" });
    try {
      const res = await runMcp(
        ["--client", id, "--project", "shop"],
        [
          INIT,
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "boof_list_projects", arguments: {} },
          },
        ],
      );
      expect(res.code).toBe(0);
      const msgs = res.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const tools = msgs[1].result.tools as {
        name: string;
        inputSchema: { properties?: object };
      }[];
      const names = tools.map((t) => t.name);
      for (const n of [
        "boof_create_client",
        "boof_list_clients",
        "boof_create_webhook",
        "boof_list_webhooks",
      ]) {
        expect(names, n).not.toContain(n);
      }
      expect(names).toContain("boof_list_tasks");
      const tasks = tools.find((t) => t.name === "boof_list_tasks");
      expect(tasks?.inputSchema.properties).not.toHaveProperty("projectId");
      expect(msgs[2].result.structuredContent.projects.map((p: { id: string }) => p.id)).toEqual([
        "shop",
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 60000);

  /** One tools/call per line, after initialize; returns the results by id. */
  const callTools = async (args: string[], calls: [string, Record<string, unknown>][]) => {
    const lines = [
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...calls.map(([name, a], i) => ({
        jsonrpc: "2.0",
        id: i + 2,
        method: "tools/call",
        params: { name, arguments: a },
      })),
    ];
    const res = await runMcp(args, lines);
    const msgs = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return calls.map((_, i) => {
      const m = msgs.find((x) => x.id === i + 2);
      return (m?.result ?? m?.error) as {
        isError?: boolean;
        content?: { text: string }[];
        structuredContent?: Record<string, any>;
        message?: string;
      };
    });
  };

  it("a review-trust client cannot run the unattended-agent chain; a trusted admin client can", async () => {
    const { ProjectStore, execCommand } = await import("@boof/heart");
    const reviewId = await makeClient({
      name: "mcp-host",
      scopes: [...REVIEW_SCOPES],
      trust: "review",
    });
    const adminId = await makeClient({ name: "mcp-admin", scopes: ["admin"], trust: "trusted" });
    const base = await mkdtemp(join(tmpdir(), "boof-mcp-repos-"));
    const repoDir = join(base, "repo");
    const elsewhere = join(base, "elsewhere");
    for (const d of [repoDir, elsewhere]) {
      await mkdir(d, { recursive: true });
      await execCommand("git", ["init", "-q"], { launch: { kind: "direct" }, cwd: d });
    }
    await new ProjectStore(root).create({ workingDirectory: repoDir, id: "shop" });
    const chain: [string, Record<string, unknown>][] = [
      ["boof_create_project", { workingDirectory: elsewhere }],
      ["boof_create_task", { projectId: "shop", title: "Do", prompt: "p", status: "pending" }],
      [
        "boof_update_project",
        { projectId: "shop", worktree: { root: "/tmp" }, budget: { perTaskUsd: 999 } },
      ],
      ["boof_set_runner", { enabled: true }],
      ["boof_list_projects", {}],
    ];
    const plain = await callTools(["--client", reviewId], chain);
    const text = (r: (typeof plain)[number]) => r?.content?.[0]?.text ?? r?.message ?? "";
    expect(text(plain[0]!)).toMatch(/^forbidden_trust:/);
    // A drafted task still works, as a draft awaiting a human.
    expect(plain[1]!.isError).toBeFalsy();
    expect(plain[1]!.structuredContent?.frontmatter.status).toBe("draft");
    expect(text(plain[2]!)).toMatch(/^forbidden_trust:/);
    expect(text(plain[3]!)).toMatch(/^forbidden_trust:/);
    expect(plain[4]!.structuredContent?.projects).toHaveLength(1);
    const queue = await callTools(
      ["--client", reviewId],
      [["boof_queue_task", { projectId: "shop", taskId: "do" }]],
    );
    expect(text(queue[0]!)).toMatch(/^forbidden_trust:/);
    // A trusted client with the admin scope can do the same chain once the directory is allowed.
    // (The removed --admin flag was the local principal, which is not bound by allowedProjectRoots.)
    const { SettingsStore, defaultSettings } = await import("@boof/heart");
    const settings = defaultSettings();
    settings.security = { ...settings.security, allowedProjectRoots: [base] };
    await new SettingsStore(root).save(settings);
    const admin = await callTools(
      ["--client", adminId],
      [
        ["boof_create_project", { workingDirectory: elsewhere }],
        ["boof_create_task", { projectId: "shop", title: "Do 2", prompt: "p", status: "pending" }],
        ["boof_set_runner", { enabled: true }],
      ],
    );
    expect(admin[0]!.isError).toBeFalsy();
    expect(admin[1]!.structuredContent?.frontmatter.status).toBe("pending");
    expect(admin[2]!.isError).toBeFalsy();
    await rm(base, { recursive: true, force: true });
  }, 90000);

  it("with --client the client's scopes decide", async () => {
    await new AuthStore(root).create({ name: "boss", scopes: ["admin"], trust: "trusted" });
    const [client] = await new AuthStore(root).list();
    const names = await toolNames(["--client", client.id]);
    expect(names).toContain("boof_create_client");
    expect(names).toContain("boof_update_settings");
  }, 30000);

  it("acts as --client with that client's scopes", async () => {
    await new AuthStore(root).create({
      name: "reader",
      scopes: ["tasks:read"],
      trust: "review",
    });
    const [client] = await new AuthStore(root).list();
    const res = await runMcp(
      ["--client", client.id],
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
    );
    const names = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))[1]
      .result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("boof_list_tasks");
    expect(names).not.toContain("boof_create_plan");
  }, 30000);
});

describe("mcpCommand", () => {
  it("prints help", async () => {
    const out: string[] = [];
    expect(
      await mcpCommand(
        ["--help"],
        () => root,
        new ToolRegistry([new MockTool()]),
        console.error,
        (l) => out.push(l),
      ),
    ).toBe(0);
    expect(out[0]).toBe(MCP_HELP);
    expect(MCP_HELP).not.toContain("--admin");
    expect(MCP_HELP).toContain("--client <id>");
  });

  it("mcp without --client exits 3 with the auth add command and MCP_REVIEW_SCOPES", async () => {
    const res = await runMcp([], []);
    expect(res.code).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(CLIENT_REQUIRED);
    const { MCP_REVIEW_SCOPES } = await import("@boof/heart-server");
    expect(res.stderr).toContain(
      `--scopes ${(MCP_REVIEW_SCOPES as readonly string[]).join(",")} --trust review`,
    );
  }, 30000);

  it("mcp --admin exits 3 with the trusted-admin hint", async () => {
    const errs: string[] = [];
    const code = await mcpCommand(
      ["-d", root, "--client", "x", "--admin"],
      () => root,
      new ToolRegistry([new MockTool()]),
      (l) => errs.push(l),
    );
    expect(code).toBe(3);
    expect(errs).toEqual([ADMIN_REMOVED]);

    const res = await runMcp(["--admin"], []);
    expect(res.code).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(ADMIN_REMOVED);
  }, 30000);

  it("refuses a missing data root before creating it", async () => {
    const errs: string[] = [];
    const missing = join(root, "typo");
    const code = await mcpCommand(
      ["-d", missing, "--client", "nobody"],
      () => root,
      new ToolRegistry([new MockTool()]),
      (l) => errs.push(l),
    );
    expect(code).toBe(3);
    expect(errs.at(-1)).toContain("no boof data root");
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses an unknown client, a bad id, and a missing client when auth is required", async () => {
    const errs: string[] = [];
    const run = (argv: string[]) =>
      mcpCommand(
        argv,
        () => root,
        new ToolRegistry([new MockTool()]),
        (l) => errs.push(l),
      );
    // A refused identity exits 3, like the generated CLI; a bad id is a usage error (1).
    expect(await run(["-d", root, "--client", "nobody"])).toBe(3);
    expect(errs.at(-1)).toContain("unknown client");
    expect(await run(["-d", root, "--project", "Bad Id"])).toBe(1);
    expect(errs.at(-1)).toContain("kebab-case");

    const { SettingsStore, defaultSettings } = await import("@boof/heart");
    const settings = defaultSettings();
    settings.security = {
      allowedHosts: [],
      auth: { mode: "required" },
      allowedPrivateWebhookHosts: [],
      allowedProjectRoots: [],
      externalTasksRequireApproval: true,
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30, unauthenticatedPerMinute: 30 },
      trustedProxies: ["loopback"],
      audit: { enabled: true, retentionDays: 90 },
    };
    await new SettingsStore(root).save(settings);
    expect(await run(["-d", root])).toBe(3);
    expect(errs.at(-1)).toBe(CLIENT_REQUIRED);
  });
});
