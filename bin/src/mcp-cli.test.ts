import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "@boof-runner/shared";
import { mcpCommand, MCP_HELP } from "./mcp-cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "boof-runner.ts");
const tsx = join(here, "..", "..", "node_modules", ".bin", "tsx");

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

/** Spawn `boof-runner mcp`, send `lines`, close stdin and collect everything. */
function runMcp(args: string[], lines: unknown[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(tsx, [entry, "mcp", "-d", root, ...args], { stdio: "pipe" });
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
    const res = await runMcp(
      [],
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

  it("without --client the administration tools need --admin", async () => {
    const adminOnly = [
      "boof_create_client",
      "boof_list_clients",
      "boof_create_webhook",
      "boof_update_settings",
      "boof_create_command",
      "boof_delete_project",
    ];
    const plain = await toolNames([]);
    for (const n of adminOnly) expect(plain, n).not.toContain(n);
    expect(plain).toContain("boof_create_plan");
    expect(plain).toContain("boof_set_runner");
    const admin = await toolNames(["--admin"]);
    for (const n of adminOnly) expect(admin, n).toContain(n);
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

  it("without --admin the host acts as a review-trust client: the unattended-agent chain fails at every step", async () => {
    const { ProjectStore, execCommand } = await import("@boof-runner/shared");
    const base = await mkdtemp(join(tmpdir(), "boof-mcp-repos-"));
    const repoDir = join(base, "repo");
    const elsewhere = join(base, "elsewhere");
    for (const d of [repoDir, elsewhere]) {
      await mkdir(d, { recursive: true });
      await execCommand("git", ["init", "-q"], { cwd: d });
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
    const plain = await callTools([], chain);
    const text = (r: (typeof plain)[number]) => r?.content?.[0]?.text ?? r?.message ?? "";
    expect(text(plain[0]!)).toMatch(/^forbidden_trust:/);
    // A drafted task still works, as a draft awaiting a human.
    expect(plain[1]!.isError).toBeFalsy();
    expect(plain[1]!.structuredContent?.frontmatter.status).toBe("draft");
    expect(text(plain[2]!)).toMatch(/^forbidden_trust:/);
    expect(text(plain[3]!)).toMatch(/^forbidden_trust:/);
    expect(plain[4]!.structuredContent?.projects).toHaveLength(1);
    const queue = await callTools([], [["boof_queue_task", { projectId: "shop", taskId: "do" }]]);
    expect(text(queue[0]!)).toMatch(/^forbidden_trust:/);
    // With --admin the same chain works.
    const admin = await callTools(
      ["--admin"],
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

  it("with --client the client's scopes decide, with no --admin needed", async () => {
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
        console.error,
        (l) => out.push(l),
      ),
    ).toBe(0);
    expect(out[0]).toBe(MCP_HELP);
  });

  it("refuses an unknown client, a bad id, and a missing client when auth is required", async () => {
    const errs: string[] = [];
    const run = (argv: string[]) =>
      mcpCommand(
        argv,
        () => root,
        (l) => errs.push(l),
      );
    expect(await run(["-d", root, "--client", "nobody"])).toBe(1);
    expect(errs.at(-1)).toContain("unknown client");
    expect(await run(["-d", root, "--project", "Bad Id"])).toBe(1);
    expect(errs.at(-1)).toContain("kebab-case");
    expect(await run(["-d", root, "--client", "x", "--admin"])).toBe(1);
    expect(errs.at(-1)).toContain("--admin");

    const { SettingsStore, defaultSettings } = await import("@boof-runner/shared");
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
    expect(await run(["-d", root])).toBe(1);
    expect(errs.at(-1)).toContain("--client");
  });
});
