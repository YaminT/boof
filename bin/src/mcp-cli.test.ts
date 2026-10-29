import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
    // Give the server time to answer before the pipe closes.
    for (const m of lines) child.stdin.write(line(m));
    setTimeout(() => child.stdin.end(), 2500);
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

    const { SettingsStore, defaultSettings } = await import("@boof-runner/shared");
    const settings = defaultSettings();
    settings.security = {
      allowedHosts: [],
      auth: { mode: "required" },
      allowedProjectRoots: [],
      externalTasksRequireApproval: true,
      rateLimit: { perMinute: 600, attachmentsPerMinute: 30 },
      audit: { enabled: true, retentionDays: 90 },
    };
    await new SettingsStore(root).save(settings);
    expect(await run(["-d", root])).toBe(1);
    expect(errs.at(-1)).toContain("--client");
  });
});
