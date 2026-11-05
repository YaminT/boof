import { createServer } from "node:http";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Settings } from "@boof/heart";
import { AgentAuthRefusedError, AgentAuthResolver, claudeAgentEnv } from "./agent-auth.js";
import { agentEnv } from "./agent-env.js";

const dirs: string[] = [];
const makeProject = (claudeAgent?: Project["claudeAgent"]): Project =>
  ({ id: "p", name: "Project", path: "/tmp/project", claudeAgent }) as Project;
const settings = (url?: string) =>
  ({ owlish: url ? { url, healthGate: "pause" } : undefined }) as Settings;
const listen = async (body: string, status = 200) => {
  const server = createServer((req, res) => {
    expect(req.headers["x-api-key"]).toBeTruthy();
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return { server, url: `http://127.0.0.1:${address.port}` };
};
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) =>
        import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })),
      ),
  );
});

describe("claudeAgentEnv", () => {
  const credentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_CONFIG_DIR",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_GATEWAY_TOKEN",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_API_KEY",
    "GCLOUD_PROJECT",
    "CLOUD_ML_REGION",
    "VERTEX_PROJECT",
    "AZURE_OPENAI_API_KEY",
    "BOOF_SECRET",
  ];
  it.each(["gateway", "project-key"] as const)(
    "drops all credential families from extra and parent env (%s mode)",
    (mode) => {
      const input = Object.fromEntries(credentials.map((name) => [name, "inherited-secret"]));
      const auth =
        mode === "gateway"
          ? { kind: "gateway" as const, url: "http://127.0.0.1:9000", apiKey: "client" }
          : { kind: "project-key" as const, apiKey: "project" };
      const result = claudeAgentEnv(
        agentEnv(input, credentials),
        auth,
        "app",
        "/private/project-config",
      );
      for (const name of credentials) {
        if (
          name === "CLAUDE_CONFIG_DIR" ||
          (mode === "gateway" && name === "ANTHROPIC_BASE_URL") ||
          (mode === "gateway" && name === "ANTHROPIC_API_KEY") ||
          (mode === "project-key" && name === "ANTHROPIC_API_KEY")
        )
          continue;
        expect(result, name).not.toHaveProperty(name);
      }
      expect(result.CLAUDE_CONFIG_DIR).toBe("/private/project-config");
      expect(result.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("app");
      if (mode === "gateway")
        expect(result).toMatchObject({
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9000",
          ANTHROPIC_API_KEY: "client",
        });
      else expect(result.ANTHROPIC_API_KEY).toBe("project");
    },
  );
  it("retains safe agent basics and adds only explicit auth", () => {
    expect(
      claudeAgentEnv(
        { PATH: "/bin", HOME: "/home/u", LANG: "C", TERM: "xterm", TMPDIR: "/tmp" },
        { kind: "project-key", apiKey: "project" },
        "app",
        "/cfg",
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      LANG: "C",
      TERM: "xterm",
      TMPDIR: "/tmp",
      ANTHROPIC_API_KEY: "project",
      CLAUDE_AGENT_SDK_CLIENT_APP: "app",
      CLAUDE_CONFIG_DIR: "/cfg",
    });
  });
  it("bypasses inherited proxies for the checked gateway host", () => {
    const result = claudeAgentEnv(
      { NO_PROXY: "localhost", no_proxy: "internal", HTTPS_PROXY: "http://proxy" },
      { kind: "gateway", url: "http://127.0.0.1:9000", apiKey: "client" },
      "app",
      "/cfg",
    );
    expect(result.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(result.no_proxy).toBe("internal,127.0.0.1");
    expect(result.ANTHROPIC_API_KEY).toBe("client");
    expect(result).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
  it("refuses gateway environment construction without an explicit key", () => {
    expect(() =>
      claudeAgentEnv({}, { kind: "gateway", url: "http://127.0.0.1:9000" }, "app", "/cfg"),
    ).toThrow(/credentials are required/);
  });
});

describe("AgentAuthResolver", () => {
  it("caches eligibility for 30 seconds across projects on the same gateway", async () => {
    const { server, url } = await listen(
      JSON.stringify([
        { id: "a", name: "console", provider: "claude-console-api", hasRefreshToken: false },
      ]),
    );
    const fetcher = vi.fn(fetch);
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(url),
      readGatewayKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
      fetch: fetcher,
    });
    await expect(resolver.decide(makeProject())).resolves.toMatchObject({
      ok: true,
      via: "gateway",
    });
    await expect(resolver.decide(makeProject())).resolves.toMatchObject({
      ok: true,
      via: "gateway",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    server.close();
  });
  it("gateway mode gives the child the agent key and never the admin key", async () => {
    const { server, url } = await listen(
      JSON.stringify([
        { id: "a", name: "console", provider: "claude-console-api", hasRefreshToken: false },
      ]),
    );
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(url),
      readGatewayKey: async () => "ADMIN-KEY-1",
      readAgentKey: async () => "AGENT-KEY-1",
    });
    const decision = await resolver.decide(makeProject());
    expect(decision).toMatchObject({ ok: true, via: "gateway" });
    const auth = await resolver.credentials(makeProject(), decision as never);
    expect(auth).toMatchObject({ kind: "gateway", apiKey: "AGENT-KEY-1" });
    const env = claudeAgentEnv({ PATH: "/bin" }, auth, "app", "/cfg");
    expect(env.ANTHROPIC_API_KEY).toBe("AGENT-KEY-1");
    expect(JSON.stringify([auth, env])).not.toContain("ADMIN-KEY-1");
    server.close();
  });
  it("the child env never holds the admin key even when it is inherited", () => {
    for (const auth of [
      { kind: "gateway" as const, url: "http://127.0.0.1:9000", apiKey: "AGENT-KEY-1" },
      { kind: "project-key" as const, apiKey: "project" },
    ]) {
      const env = claudeAgentEnv(
        { PATH: "/bin", BOOF_OWLISH_API_KEY: "ADMIN-KEY-1", BOOF_OWLISH_AGENT_KEY: "X" },
        auth,
        "app",
        "/cfg",
      );
      expect(JSON.stringify(env)).not.toContain("ADMIN-KEY-1");
      expect(env).not.toHaveProperty("BOOF_OWLISH_API_KEY");
    }
  });
  it("gateway without an agent key refuses with a clear reason, or falls back to the project key", async () => {
    const { server, url } = await listen(
      JSON.stringify([
        { id: "a", name: "console", provider: "claude-console-api", hasRefreshToken: false },
      ]),
    );
    const base = {
      root: "/tmp/unused",
      loadSettings: async () => settings(url),
      readGatewayKey: async () => "ADMIN-KEY-1",
      readAgentKey: async () => null,
    };
    const refused = await new AgentAuthResolver(base).decide(makeProject());
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "set an api-only better-ccflare agent key (Settings › Accounts) or a project API key",
      ),
    });
    expect(JSON.stringify(refused)).not.toContain("ADMIN-KEY-1");
    const fallback = await new AgentAuthResolver({
      ...base,
      projectKeys: {
        has: async () => true,
        get: async () => "sk-ant-api03-1234567890123456",
      } as never,
    }).decide(makeProject());
    expect(fallback).toMatchObject({ ok: true, via: "project-key" });
    server.close();
  });
  it("does not contact the gateway for project-key auth", async () => {
    const fetcher = vi.fn(fetch);
    const projectKeys = {
      has: async () => true,
      get: async () => "sk-ant-api03-1234567890123456",
    } as never;
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings("http://127.0.0.1:8089"),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      projectKeys,
      fetch: fetcher,
    });
    await expect(resolver.decide(makeProject({ auth: "project-key" }))).resolves.toMatchObject({
      ok: true,
      via: "project-key",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses without settings and makes no gateway request", async () => {
    const fetcher = vi.fn(fetch);
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      fetch: fetcher,
    });
    const decision = await resolver.decide(makeProject());
    expect(decision).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no better-ccflare gateway is configured"),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("falls back to the project key when gateway mode has no client key", async () => {
    const projectKeys = {
      has: async () => true,
      get: async () => "sk-ant-api03-1234567890123456",
    } as never;
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings("http://127.0.0.1:8089"),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      projectKeys,
    });
    const decision = await resolver.decide(makeProject());
    expect(decision).toMatchObject({
      ok: true,
      via: "project-key",
      note: expect.stringContaining("no better-ccflare client key is configured"),
    });
    if (decision.ok)
      await expect(resolver.credentials(makeProject(), decision)).resolves.toMatchObject({
        kind: "project-key",
      });
  });
  it("refuses without a project key when the gateway has no client key", async () => {
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings("http://127.0.0.1:8089"),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      projectKeys: { has: async () => false } as never,
    });
    await expect(resolver.decide(makeProject())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /no better-ccflare client key is configured.*Set an Anthropic API key/,
      ),
    });
  });
  it("fails closed if a chosen project key vanished before credentials are read", async () => {
    const keys = { has: async () => true, get: async () => null } as never;
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      projectKeys: keys,
    });
    await expect(
      resolver.credentials(makeProject({ auth: "project-key" }), {
        ok: true,
        via: "project-key",
        note: null,
      }),
    ).rejects.toBeInstanceOf(AgentAuthRefusedError);
  });
  it("refuses if the gateway settings change after the checked decision", async () => {
    const { server, url } = await listen(
      JSON.stringify([
        { id: "a", name: "console", provider: "claude-console-api", hasRefreshToken: false },
      ]),
    );
    let current = url;
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(current),
      readGatewayKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
    });
    const decision = await resolver.decide(makeProject());
    current = "http://127.0.0.1:1";
    await expect(resolver.credentials(makeProject(), decision as never)).rejects.toBeInstanceOf(
      AgentAuthRefusedError,
    );
    server.close();
  });
  it("coalesces simultaneous checks and caches by gateway and client key", async () => {
    const { server, url } = await listen(
      JSON.stringify([
        { id: "a", name: "console", provider: "claude-console-api", hasRefreshToken: false },
      ]),
    );
    let key = "client-key";
    const fetcher = vi.fn(fetch);
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(url),
      readGatewayKey: async () => key,
      readAgentKey: async () => "agent-key",
      fetch: fetcher,
    });
    await Promise.all(Array.from({ length: 5 }, () => resolver.decide(makeProject())));
    expect(fetcher).toHaveBeenCalledTimes(1);
    key = "other-key";
    await resolver.decide(makeProject());
    expect(fetcher).toHaveBeenCalledTimes(2);
    server.close();
  });
  it("turns settings and key-store failures into safe refusals", async () => {
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => {
        throw new Error("secret-key settings error");
      },
      readGatewayKey: async () => {
        throw new Error("secret-key key error");
      },
      readAgentKey: async () => null,
      projectKeys: {
        has: async () => {
          throw new Error("secret-key store error");
        },
      } as never,
    });
    const decision = await resolver.decide(makeProject());
    expect(decision).toMatchObject({ ok: false });
    expect(JSON.stringify(decision)).not.toContain("secret-key");
  });
  it("refuses a corrupt project key file without exposing its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-agent-corrupt-keys-"));
    dirs.push(root);
    await mkdir(join(root, "owlish"), { recursive: true });
    await writeFile(join(root, "owlish", "project-keys.json"), '{"keys":{"p":"secret-marker"');
    const resolver = new AgentAuthResolver({
      root,
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
    });
    const decision = await resolver.decide(makeProject());
    expect(decision).toMatchObject({ ok: false });
    expect(JSON.stringify(decision)).not.toContain("secret-marker");
  });
  it("rejects invalid stored key values including inherited object properties", async () => {
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      projectKeys: { get: async () => "constructor" } as never,
    });
    await expect(
      resolver.credentials(makeProject({ auth: "project-key" }), {
        ok: true,
        via: "project-key",
        note: null,
      }),
    ).rejects.toBeInstanceOf(AgentAuthRefusedError);
  });
  it("converts project key read errors in credentials into a refusal", async () => {
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
      projectKeys: {
        get: async () => {
          throw new Error("secret-marker");
        },
      } as never,
    });
    await expect(
      resolver.credentials(makeProject({ auth: "project-key" }), {
        ok: true,
        via: "project-key",
        note: null,
      }),
    ).rejects.toMatchObject({ name: "AgentAuthRefusedError" });
  });
  it("creates private per-project config folders under the supplied temporary root", async () => {
    const root = await mkdtemp(join(tmpdir(), "boof-agent-config-"));
    dirs.push(root);
    const resolver = new AgentAuthResolver({
      root,
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
      readAgentKey: async () => "agent-key",
    });
    const folder = await resolver.configDir(makeProject());
    expect(folder).toBe(join(root, "claude-agent-config", "p"));
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    const env = claudeAgentEnv(
      {},
      { kind: "project-key", apiKey: "sk-ant-api03-abcdefghijklmnop" },
      "app",
      folder,
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, "claude-agent-config", "p"));
    expect(env.CLAUDE_CONFIG_DIR).not.toBe(makeProject().path);
  });
});
