import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, type Settings } from "@boof/heart";
import { InternalPoolBackend } from "@boof/owlish";
import { agentEnv } from "./agent-env.js";
import { AgentAuthResolver } from "./agent-auth.js";
import { gatewayEnv, toolUsesPool } from "./gateway-env.js";
import { PoolGate } from "./pool-gate.js";
import { ClaudeCodeTool } from "./tools/claude-code.js";
import { CodexTool } from "./tools/codex.js";
import { OpencodeTool } from "./tools/opencode.js";

const KEY = "sk-ant-api03-WIRINGKEYWIRINGKEY00";
const KEY2 = "sk-ant-api03-WIRINGKEY2WIRINGKEY2";

let root: string;
let upstream: http.Server;
let seenKeys: string[];
let backend: InternalPoolBackend;
let settings: Settings;

const internalSettings = (over: Partial<NonNullable<Settings["gateway"]>> = {}): Settings => ({
  ...defaultSettings(),
  gateway: { mode: "internal", ...over },
});
const gate = () =>
  new PoolGate({
    root,
    loadSettings: async () => settings,
    readKey: async () => null,
    readAgentKey: async () => null,
    internal: backend,
  });

async function post(url: string, token: string): Promise<number> {
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }),
  });
  await res.arrayBuffer();
  return res.status;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-gw-wiring-"));
  seenKeys = [];
  upstream = http.createServer((req, res) => {
    seenKeys.push(String(req.headers["x-api-key"]));
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg", usage: { input_tokens: 1, output_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  backend = new InternalPoolBackend({
    root,
    upstreamOrigin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  });
  settings = internalSettings();
});
afterEach(async () => {
  await backend.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

describe("internal gateway: env and tokens", () => {
  it("gives a run a token and the loopback URL, never an account key", async () => {
    await backend.add({ name: "work", apiKey: KEY });
    const g = await gate().gateway({ runId: "t1", projectId: "p" });
    expect(g).toBeDefined();
    expect(g!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(g!.apiKey).toMatch(/^bgw_/);
    expect(g!.apiKey).not.toBe(KEY);
    // What the claude-code adapter builds: an inherited real gateway is replaced, not kept.
    const child = {
      ...agentEnv(
        {
          PATH: "/usr/bin",
          ANTHROPIC_BASE_URL: "http://localhost:8080",
          ANTHROPIC_AUTH_TOKEN: "x",
        },
        undefined,
        undefined,
        { injectPoolCredential: true },
      ),
      ...gatewayEnv("anthropic", g),
    };
    expect(child.ANTHROPIC_BASE_URL).toBe(g!.url);
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe(g!.apiKey);
    expect(Object.values(child).join("\n")).not.toContain(KEY);
  });

  it("forwards with the account key, and revokes the token when the run ends", async () => {
    await backend.add({ name: "work", apiKey: KEY });
    const pool = gate();
    const g = (await pool.gateway({ runId: "t1" }))!;
    expect(await post(g.url, g.apiKey!)).toBe(200);
    expect(seenKeys).toEqual([KEY]);
    await pool.releaseRun("t1");
    expect(await post(g.url, g.apiKey!)).toBe(401);
    expect(seenKeys).toEqual([KEY]);
  });

  it("gives each run its own token", async () => {
    await backend.add({ name: "work", apiKey: KEY });
    const pool = gate();
    const a = (await pool.gateway({ runId: "a" }))!;
    const b = (await pool.gateway({ runId: "b" }))!;
    expect(a.apiKey).not.toBe(b.apiKey);
    await pool.releaseRun("a");
    expect(await post(b.url, b.apiKey!)).toBe(200);
  });

  it("routes nothing without accounts, without a run, or when the mode is not internal", async () => {
    expect(await gate().gateway({ runId: "t" })).toBeUndefined();
    await backend.add({ name: "work", apiKey: KEY });
    expect(await gate().gateway()).toBeUndefined();
    settings = { ...defaultSettings(), gateway: { mode: "none" } };
    expect(await gate().gateway({ runId: "t" })).toBeUndefined();
  });

  it("absent settings: no pool, no gateway, nothing written under the data root", async () => {
    settings = defaultSettings();
    const pool = gate();
    expect(await pool.gateway({ runId: "t" })).toBeUndefined();
    expect(await pool.childCredential()).toEqual({ kind: "ok" });
    const check = await pool.check();
    expect(check).toMatchObject({ blocked: false, policy: null });
    expect(check.pool.status).toBe("absent");
    await pool.releaseRun("t");
    expect(await readdir(root)).toEqual([]);
  });

  it("the pool gate pauses on an unusable pool and resumes", async () => {
    const acc = await backend.add({ name: "work", apiKey: KEY });
    const pool = gate();
    expect((await pool.check()).blocked).toBe(false);
    await backend.pause(acc.id);
    const down = await pool.check();
    expect(down.blocked).toBe(true);
    expect(down.pool.status).toBe("unhealthy");
    settings = internalSettings({ healthGate: "warn" });
    expect((await pool.check()).blocked).toBe(false);
    settings = internalSettings({ healthGate: "off" });
    expect((await pool.check()).policy).toBe("off");
    settings = internalSettings();
    await backend.resume(acc.id);
    expect((await pool.check()).blocked).toBe(false);
  });

  it("applies the configured strategy", async () => {
    await backend.add({ name: "a", apiKey: KEY, priority: 0 });
    await backend.add({ name: "b", apiKey: KEY2, priority: 1 });
    settings = internalSettings({ strategy: "round-robin" });
    const pool = gate();
    const g = (await pool.gateway({ runId: "t" }))!;
    await post(g.url, g.apiKey!);
    await post(g.url, g.apiKey!);
    expect(new Set(seenKeys)).toEqual(new Set([KEY, KEY2]));
  });
});

describe("internal gateway: codex stays outside the pool", () => {
  it("hands the gateway to claude-code and opencode, never to codex, in internal mode", () => {
    expect(toolUsesPool(new CodexTool(), "internal")).toBe(false);
    expect(toolUsesPool(new ClaudeCodeTool(), "internal")).toBe(true);
    expect(toolUsesPool(new OpencodeTool(), "internal")).toBe(true);
    // better-ccflare still serves codex
    expect(toolUsesPool(new CodexTool(), "better-ccflare")).toBe(true);
  });
});

describe("gateway env: loopback is never sent through a proxy", () => {
  const gw = { url: "http://127.0.0.1:4321", apiKey: "bgw_x" };
  it("adds 127.0.0.1 to NO_PROXY for anthropic and opencode, keeping what was there", () => {
    const env = gatewayEnv("anthropic", gw, { NO_PROXY: "example.org", HTTP_PROXY: "http://p" });
    expect(env.NO_PROXY).toBe("example.org,127.0.0.1");
    expect(env.no_proxy).toBe("example.org,127.0.0.1");
    expect(gatewayEnv("opencode", gw).NO_PROXY).toBe("127.0.0.1");
    expect(gatewayEnv("anthropic", gw, { NO_PROXY: "127.0.0.1" }).NO_PROXY).toBe("127.0.0.1");
  });
});

describe("internal gateway: claude-agent auth", () => {
  it("is eligible with an account, hands out a run token, and refuses an empty pool", async () => {
    const auth = new AgentAuthResolver({
      root,
      loadSettings: async () => settings,
      readGatewayKey: async () => null,
      readAgentKey: async () => null,
      internal: backend,
    });
    const project = { id: "p", name: "P" } as never;
    const empty = await auth.decide(project);
    expect(empty.ok).toBe(false);
    await backend.add({ name: "work", apiKey: KEY });
    const decision = await auth.decide(project);
    expect(decision).toMatchObject({ ok: true, via: "gateway" });
    const creds = await auth.credentials(project, decision as never, "t9");
    expect(creds).toMatchObject({ kind: "gateway" });
    if (creds.kind !== "gateway") throw new Error("unreachable");
    expect(creds.apiKey).toMatch(/^bgw_/);
    expect(await post(creds.url, creds.apiKey)).toBe(200);
    await backend.releaseRun("t9");
    expect(await post(creds.url, creds.apiKey)).toBe(401);
  });
});

describe.skipIf(process.platform === "win32")(
  "integration: a fake claude through the gateway",
  () => {
    it("posts to $ANTHROPIC_BASE_URL with $ANTHROPIC_AUTH_TOKEN; the upstream sees the key", async () => {
      await backend.add({ name: "work", apiKey: KEY });
      const bin = join(root, "claude");
      await writeFile(
        bin,
        `#!/usr/bin/env node
const base = process.env.ANTHROPIC_BASE_URL, tok = process.env.ANTHROPIC_AUTH_TOKEN;
fetch(base + "/v1/messages", { method: "POST", headers: { "x-api-key": tok, "content-type": "application/json" }, body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }) })
  .then(async (r) => { await r.arrayBuffer();
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "status " + r.status, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } })); });
`,
      );
      await chmod(bin, 0o755);
      const prev = process.env.BOOF_RUNNER_CLAUDE_BIN;
      process.env.BOOF_RUNNER_CLAUDE_BIN = bin;
      const pool = gate();
      try {
        const g = await pool.gateway({ runId: "task-1", projectId: "p" });
        const res = await new ClaudeCodeTool().run({
          role: "developer",
          model: "m",
          systemPrompt: "s",
          prompt: "go",
          cwd: root,
          autoApprove: true,
          gateway: g,
          timeoutMs: 20_000,
        });
        expect(res.output + res.report).toContain("status 200");
        expect(seenKeys).toEqual([KEY]);
        await pool.releaseRun("task-1");
        expect(await post(g!.url, g!.apiKey!)).toBe(401);
      } finally {
        if (prev === undefined) delete process.env.BOOF_RUNNER_CLAUDE_BIN;
        else process.env.BOOF_RUNNER_CLAUDE_BIN = prev;
      }
    });
  },
);
