import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Settings } from "@boof/heart";
import { AgentAuthRefusedError, AgentAuthResolver, claudeAgentEnv } from "./agent-auth.js";

const dirs: string[] = [];
const makeProject = (claudeAgent?: Project["claudeAgent"]): Project =>
  ({ id: "p", name: "Project", path: "/tmp/project", claudeAgent }) as Project;
const settings = (url?: string) =>
  ({ owlish: url ? { url, healthGate: "pause" } : undefined }) as Settings;
const listen = async (body: string, status = 200) => {
  const server = createServer((req, res) => {
    expect(req.headers["x-api-key"]).toBe("client-key");
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
  const inherited = {
    ANTHROPIC_API_KEY: "inherited",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_FOUNDRY_RESOURCE: "resource",
    ANTHROPIC_BASE_URL: "https://evil.invalid",
    BOOF_SECRET: "never",
  };
  it("clears inherited provider credentials and adds only the gateway credentials", () => {
    const result = claudeAgentEnv(
      inherited,
      { kind: "gateway", url: "http://127.0.0.1:9000", apiKey: "client" },
      "boof-runner/0.3.0",
    );
    expect(result).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9000",
      ANTHROPIC_AUTH_TOKEN: "client",
      CLAUDE_AGENT_SDK_CLIENT_APP: "boof-runner/0.3.0",
    });
  });
  it("adds only the project API key in project-key mode", () => {
    expect(
      claudeAgentEnv(inherited, { kind: "project-key", apiKey: "project-secret" }, "app"),
    ).toEqual({ ANTHROPIC_API_KEY: "project-secret", CLAUDE_AGENT_SDK_CLIENT_APP: "app" });
  });
  it("does not add an absent gateway client key", () => {
    expect(claudeAgentEnv({}, { kind: "gateway", url: "http://127.0.0.1:9000" }, "app")).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9000",
      CLAUDE_AGENT_SDK_CLIENT_APP: "app",
    });
  });
});

describe("AgentAuthResolver", () => {
  it("caches eligibility for 30 seconds across projects on the same gateway", async () => {
    const { server, url } = await listen(
      JSON.stringify([{ id: "a", name: "console", provider: "claude-console-api" }]),
    );
    const fetcher = vi.fn(fetch);
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(url),
      readGatewayKey: async () => "client-key",
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
      fetch: fetcher,
    });
    const decision = await resolver.decide(makeProject());
    expect(decision).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no better-ccflare gateway is configured"),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed if a chosen project key vanished before credentials are read", async () => {
    const keys = { has: async () => true, get: async () => null } as never;
    const resolver = new AgentAuthResolver({
      root: "/tmp/unused",
      loadSettings: async () => settings(),
      readGatewayKey: async () => null,
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
});
