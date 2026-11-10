import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { agentEnv } from "./agent-env.js";
import { gatewayEnv } from "./gateway-env.js";
import { MockTool } from "./tools/mock.js";
import { ClaudeCodeTool } from "./tools/claude-code.js";
import { CodexTool, codexProviderConfig } from "./tools/codex.js";
import { OpencodeTool } from "./tools/opencode.js";

describe("agentEnv", () => {
  const server = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    USER: "u",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TERM: "xterm",
    TMPDIR: "/tmp",
    TZ: "UTC",
    ANTHROPIC_BASE_URL: "http://gateway",
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_AUTH_TOKEN: "admin-token",
    ANTHROPIC_MODEL: "sonnet",
    CLAUDE_CODE_USE_BEDROCK: "1",
    OPENAI_API_KEY: "sk-oai",
    OPENAI_BASE_URL: "http://inherited/v1",
    CODEX_HOME: "/home/u/.codex",
    OPENCODE_CONFIG: "/x",
    OPENCODE_CONFIG_CONTENT: '{"apiKey":"inherited"}',
    HTTPS_PROXY: "http://proxy",
    XDG_CONFIG_HOME: "/home/u/.config",
    BOOF_KEY: "boof_secret",
    BOOF_URL: "http://127.0.0.1:4319",
    BOOF_RUNNER_DATA_ROOT: "/data",
    BOOF_RUNNER_PORT: "4319",
    AWS_SECRET_ACCESS_KEY: "aws",
    GITHUB_TOKEN: "ghp",
    SSH_AUTH_SOCK: "/tmp/agent",
    SOME_OTHER: "x",
  } as NodeJS.ProcessEnv;

  it("keeps the basics and the tools' own variables, and drops everything else", () => {
    const env = agentEnv(server);
    for (const k of [
      "PATH",
      "HOME",
      "USER",
      "LANG",
      "LC_ALL",
      "TERM",
      "TMPDIR",
      "TZ",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CODEX_HOME",
      "OPENCODE_CONFIG",
      "HTTPS_PROXY",
      "XDG_CONFIG_HOME",
    ]) {
      expect(env[k], k).toBe(server[k]);
    }
    for (const k of [
      "BOOF_KEY",
      "BOOF_URL",
      "BOOF_RUNNER_DATA_ROOT",
      "BOOF_RUNNER_PORT",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "SOME_OTHER",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENCODE_CONFIG_CONTENT",
    ]) {
      expect(env, k).not.toHaveProperty(k);
    }
  });

  it("runner.agentEnv cannot put gateway credentials back", () => {
    const env = agentEnv(server, [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENCODE_CONFIG_CONTENT",
      "GITHUB_TOKEN",
    ]);
    expect(env.GITHUB_TOKEN).toBe("ghp");
    expect(env.ANTHROPIC_MODEL).toBe("sonnet");
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENCODE_CONFIG_CONTENT",
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it("passes the names of runner.agentEnv through, but never a BOOF_ variable", () => {
    const env = agentEnv(server, ["GITHUB_TOKEN", "BOOF_KEY", "NOT_SET"]);
    expect(env.GITHUB_TOKEN).toBe("ghp");
    expect(env).not.toHaveProperty("BOOF_KEY");
    expect(env).not.toHaveProperty("NOT_SET");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("drops boof credentials and adds only the explicit marker", () => {
    const marker = "0123456789abcdef0123456789abcdef";
    const env = agentEnv(
      { ...server, BOOF_RUNNER_AGENT_OF: "inherited" },
      ["BOOF_RUNNER_AGENT_OF"],
      marker,
    );
    expect(env).not.toHaveProperty("BOOF_KEY");
    expect(env).not.toHaveProperty("BOOF_URL");
    expect(env).not.toHaveProperty("BOOF_RUNNER_DATA_ROOT");
    expect(env.BOOF_RUNNER_AGENT_OF).toBe(marker);
    expect(Object.keys(env).filter((name) => name.startsWith("BOOF_"))).toEqual([
      "BOOF_RUNNER_AGENT_OF",
    ]);
  });

  it("ignores BOOF_RUNNER_AGENT_OF in extra and parent env unless marker is passed", () => {
    const input = { BOOF_RUNNER_AGENT_OF: "parent" } as NodeJS.ProcessEnv;
    expect(agentEnv(input, ["BOOF_RUNNER_AGENT_OF"])).not.toHaveProperty("BOOF_RUNNER_AGENT_OF");
    expect(agentEnv(input, ["BOOF_RUNNER_AGENT_OF"], "explicit").BOOF_RUNNER_AGENT_OF).toBe(
      "explicit",
    );
  });
});

describe("what each adapter really hands its child", () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const set = (k: string, v: string) => {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  };

  async function envOf(binVar: string, name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "boof-env-"));
    dirs.push(dir);
    const bin = join(dir, name);
    await writeFile(bin, `#!/bin/sh\nenv > "${dir}/env"\ncat >/dev/null\necho '{}'\n`);
    await chmod(bin, 0o755);
    set(binVar, bin);
    set("BOOF_KEY", "boof_secret");
    set("BOOF_URL", "http://127.0.0.1:4319");
    set("BS_TEST_TOKEN", "bs_server_secret");
    set("AWS_SECRET_ACCESS_KEY", "aws-secret");
    set("EXTRA_PASS", "yes");
    set("ANTHROPIC_BASE_URL", "http://gateway.test");
    set("ANTHROPIC_AUTH_TOKEN", "inherited-admin-token");
    set("OPENAI_API_KEY", "inherited-openai-key");
    return dir;
  }
  const base = {
    role: "developer",
    model: "m",
    systemPrompt: "s",
    prompt: "p",
    autoApprove: true,
  } as const;

  it.each([
    ["claude", "BOOF_RUNNER_CLAUDE_BIN", () => new ClaudeCodeTool()],
    ["codex", "BOOF_RUNNER_CODEX_BIN", () => new CodexTool()],
    ["opencode", "BOOF_RUNNER_OPENCODE_BIN", () => new OpencodeTool()],
  ])(
    "%s: no BOOF_, inherited gateway credential, or unrelated secret; agentEnv names do",
    async (name, binVar, make) => {
      const dir = await envOf(binVar, name);
      const marker = "0123456789abcdef0123456789abcdef";
      try {
        await make().run({ ...base, cwd: dir, agentEnv: ["EXTRA_PASS"], agentMarker: marker });
      } catch {
        /* an empty answer may be refused; the child has run */
      }
      const env = await readFile(join(dir, "env"), "utf8");
      expect(env).not.toContain("BOOF_KEY");
      expect(env).not.toContain("BOOF_URL");
      expect(env).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(env).not.toContain("ANTHROPIC_BASE_URL=");
      expect(env).not.toContain("ANTHROPIC_AUTH_TOKEN=");
      expect(env).not.toContain("OPENAI_API_KEY=");
      expect(env).toContain("EXTRA_PASS=yes");
      expect(env).toContain("PATH=");
      expect(env).toContain(`BOOF_RUNNER_AGENT_OF=${marker}`);
      expect(env).not.toMatch(/=(?:boof_|bs_)/);
    },
  );
});

describe("routing through the account pool gateway", () => {
  const gw = { url: "http://127.0.0.1:8080/", apiKey: "ccf-client-key" };

  it("gatewayEnv: anthropic-style tools get the base URL and the auth token only when a key is set", () => {
    expect(gatewayEnv("anthropic", gw)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      ANTHROPIC_AUTH_TOKEN: "ccf-client-key",
    });
    expect(gatewayEnv("anthropic", { url: "https://gw:8080" })).toEqual({
      ANTHROPIC_BASE_URL: "https://gw:8080",
    });
  });

  it("gatewayEnv: codex gets /v1 and a dummy key when none is set", () => {
    expect(gatewayEnv("openai", gw)).toEqual({
      OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      OPENAI_API_KEY: "ccf-client-key",
    });
    expect(gatewayEnv("openai", { url: "https://gw:8080" })).toEqual({
      OPENAI_BASE_URL: "https://gw:8080/v1",
      OPENAI_API_KEY: "dummy-key",
    });
  });

  it("gatewayEnv: opencode gets its provider options as config content", () => {
    const withKey = JSON.parse(gatewayEnv("opencode", gw).OPENCODE_CONFIG_CONTENT!);
    expect(withKey).toEqual({
      provider: {
        anthropic: { options: { baseURL: "http://127.0.0.1:8080/v1", apiKey: "ccf-client-key" } },
      },
    });
    const noKey = JSON.parse(
      gatewayEnv("opencode", { url: "https://gw:8080" }).OPENCODE_CONFIG_CONTENT!,
    );
    expect(noKey.provider.anthropic.options).toEqual({ baseURL: "https://gw:8080/v1" });
  });

  it("gatewayEnv: nothing without a gateway", () => {
    for (const kind of ["anthropic", "openai", "opencode"] as const) {
      expect(gatewayEnv(kind, undefined)).toEqual({});
    }
  });

  it("normalizes TOML-unsafe URL characters through the shared settings parser", () => {
    expect(gatewayEnv("openai", { url: 'http://127.0.0.1:8080/"quoted' }).OPENAI_BASE_URL).toBe(
      "http://127.0.0.1:8080/%22quoted/v1",
    );
    expect(gatewayEnv("openai", { url: "http://[::1]:8080" }).OPENAI_BASE_URL).toBe(
      "http://[::1]:8080/v1",
    );
    expect(() => gatewayEnv("openai", { url: "http://127.0.0.1:8080?" })).toThrow();
    expect(() => gatewayEnv("openai", { url: "http://127.0.0.1:8080/has space" })).toThrow();
  });

  it("only the tools that can be pooled say so; the mock does not", () => {
    expect(new ClaudeCodeTool().acceptsPool).toBe(true);
    expect(new CodexTool().acceptsPool).toBe(true);
    expect(new OpencodeTool().acceptsPool).toBe(true);
    expect((new MockTool() as { acceptsPool?: boolean }).acceptsPool).toBeFalsy();
  });

  describe("what each adapter really hands its child", () => {
    const dirs: string[] = [];
    const saved: Record<string, string | undefined> = {};
    afterEach(async () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    });
    const set = (k: string, v: string) => {
      if (!(k in saved)) saved[k] = process.env[k];
      process.env[k] = v;
    };
    async function setup(binVar: string, name: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "boof-gw-"));
      dirs.push(dir);
      const bin = join(dir, name);
      // Records the environment and the arguments, then answers.
      await writeFile(
        bin,
        `#!/bin/sh\nenv > "${dir}/env"\necho "$@" > "${dir}/argv"\ncat >/dev/null\necho '{}'\n`,
      );
      await chmod(bin, 0o755);
      set(binVar, bin);
      // The server's own environment holds a boof key and an inherited gateway: the explicit one wins.
      set("BOOF_OWLISH_API_KEY", "ccf-client-key");
      set("BOOF_KEY", "boof_secret");
      set("ANTHROPIC_BASE_URL", "http://inherited.test");
      // The host (a Claude Code session, say) may hold its own token: start from none.
      for (const k of ["ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "OPENAI_API_KEY"]) {
        if (!(k in saved)) saved[k] = process.env[k];
        delete process.env[k];
      }
      return dir;
    }
    const base = {
      role: "developer",
      model: "m",
      systemPrompt: "s",
      prompt: "p",
      autoApprove: true,
    } as const;
    const run = async (
      make: () => { run(o: never): Promise<unknown> },
      dir: string,
      extra: object,
    ) => {
      try {
        await make().run({ ...base, cwd: dir, ...extra } as never);
      } catch {
        /* an empty answer may be refused; the child has run */
      }
      return {
        env: await readFile(join(dir, "env"), "utf8"),
        argv: await readFile(join(dir, "argv"), "utf8"),
      };
    };

    it("claude: base URL and auth token from the gateway, over an inherited URL; the key is not in argv", async () => {
      const dir = await setup("BOOF_RUNNER_CLAUDE_BIN", "claude");
      const { env, argv } = await run(() => new ClaudeCodeTool(), dir, { gateway: gw });
      expect(env).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8080\n");
      expect(env).toContain("ANTHROPIC_AUTH_TOKEN=ccf-client-key");
      expect(env).not.toContain("inherited.test");
      expect(env).not.toContain("BOOF_");
      expect(argv).not.toContain("ccf-client-key");
    });

    it("claude without a gateway does not inherit the server's gateway URL or token", async () => {
      const dir = await setup("BOOF_RUNNER_CLAUDE_BIN", "claude");
      set("ANTHROPIC_AUTH_TOKEN", "inherited-admin-token");
      const { env } = await run(() => new ClaudeCodeTool(), dir, {});
      expect(env).not.toContain("ANTHROPIC_BASE_URL=");
      expect(env).not.toContain("inherited-admin-token");
      expect(env).not.toContain("ANTHROPIC_AUTH_TOKEN=");
    });

    it("claude with a gateway but no key: no token is invented", async () => {
      const dir = await setup("BOOF_RUNNER_CLAUDE_BIN", "claude");
      set("ANTHROPIC_AUTH_TOKEN", "inherited-provider-token");
      const { env } = await run(() => new ClaudeCodeTool(), dir, { gateway: { url: gw.url } });
      expect(env).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8080\n");
      expect(env).not.toContain("ANTHROPIC_AUTH_TOKEN=");
    });

    it("codex does not receive an inherited Anthropic token next to the pool key", async () => {
      const dir = await setup("BOOF_RUNNER_CODEX_BIN", "codex");
      set("ANTHROPIC_AUTH_TOKEN", "inherited-admin-token");
      set("ANTHROPIC_API_KEY", "inherited-api-key");
      set("OPENAI_API_KEY", "inherited-openai-key");
      const { env } = await run(() => new CodexTool(), dir, { gateway: gw });
      expect(env).toContain("OPENAI_API_KEY=ccf-client-key");
      expect(env).not.toContain("inherited-admin-token");
      expect(env).not.toContain("inherited-api-key");
      expect(env).not.toContain("inherited-openai-key");
      expect(env).not.toContain("ANTHROPIC_AUTH_TOKEN=");
      expect(env).not.toContain("ANTHROPIC_BASE_URL=");
    });

    it("codex: /v1 URL and key by env, config isolation kept, key not in argv", async () => {
      const dir = await setup("BOOF_RUNNER_CODEX_BIN", "codex");
      const { env, argv } = await run(() => new CodexTool(), dir, { gateway: gw });
      expect(env).toContain("OPENAI_BASE_URL=http://127.0.0.1:8080/v1\n");
      expect(env).toContain("OPENAI_API_KEY=ccf-client-key");
      expect(env).not.toContain("BOOF_");
      expect(argv).toContain("--ignore-user-config");
      expect(argv).toContain("-c model_provider=boofpool");
      expect(argv).toContain(
        '-c model_providers.boofpool={ name = "boof pool", base_url = "http://127.0.0.1:8080/v1", env_key = "OPENAI_API_KEY", wire_api = "responses" }',
      );
      expect(argv).not.toContain("ccf-client-key");
      expect(
        new CodexTool().buildArgs({ ...base, cwd: "/tmp", gateway: gw }, "/tmp/final.txt"),
      ).toEqual([
        "exec",
        "--json",
        "--model",
        "m",
        "--ignore-user-config",
        "-c",
        "model_provider=boofpool",
        "-c",
        'model_providers.boofpool={ name = "boof pool", base_url = "http://127.0.0.1:8080/v1", env_key = "OPENAI_API_KEY", wire_api = "responses" }',
        "--dangerously-bypass-approvals-and-sandbox",
        "-o",
        "/tmp/final.txt",
        "-",
      ]);
      const open = await run(() => new CodexTool(), dir, { gateway: gw, inheritMcpServers: true });
      expect(open.argv).not.toContain("--ignore-user-config");
    });

    it("Codex gateway URL remains one TOML string even when passed a hostile host", () => {
      const probe = 'https://127.0.0.1",query_params={probe="injected"},zz="y';
      const config = codexProviderConfig(`${probe}/v1`);
      const parsed = JSON.parse(
        execFileSync(
          "python3",
          ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
          { input: config, encoding: "utf8" },
        ),
      );
      expect(parsed).toEqual({
        model_providers: {
          boofpool: {
            name: "boof pool",
            base_url: `${probe}/v1`,
            env_key: "OPENAI_API_KEY",
            wire_api: "responses",
          },
        },
      });
    });

    it("claude gateway removes inherited provider credentials and bypass flags", async () => {
      const dir = await setup("BOOF_RUNNER_CLAUDE_BIN", "claude");
      set("ANTHROPIC_API_KEY", "real-provider-key");
      set("ANTHROPIC_AUTH_TOKEN", "real-auth-token");
      set("CLAUDE_CODE_USE_BEDROCK", "1");
      set("CLAUDE_CODE_USE_FOUNDRY", "1");
      set("CLAUDE_CODE_USE_ANYTHING", "1");
      set("ANTHROPIC_CUSTOM_HEADERS", "X-Probe-Cred: secret");
      const { env } = await run(() => new ClaudeCodeTool(), dir, { gateway: gw });
      expect(env).not.toContain("ANTHROPIC_API_KEY=");
      expect(env).not.toContain("CLAUDE_CODE_USE_BEDROCK=");
      expect(env).not.toContain("CLAUDE_CODE_USE_FOUNDRY=");
      expect(env).not.toContain("CLAUDE_CODE_USE_ANYTHING=");
      expect(env).not.toContain("ANTHROPIC_CUSTOM_HEADERS=");
      expect(env).toContain("ANTHROPIC_AUTH_TOKEN=ccf-client-key");
    });

    it("rejects unsafe Codex gateway URLs before composing TOML", async () => {
      const dir = await setup("BOOF_RUNNER_CODEX_BIN", "codex");
      await expect(
        run(() => new CodexTool(), dir, { gateway: { url: 'http://gw/"\nmodel = "injected"' } }),
      ).rejects.toThrow();
    });

    it("codex without a key uses a dummy one", async () => {
      const dir = await setup("BOOF_RUNNER_CODEX_BIN", "codex");
      const { env } = await run(() => new CodexTool(), dir, { gateway: { url: gw.url } });
      expect(env).toContain("OPENAI_API_KEY=dummy-key");
    });

    it("opencode: provider options through OPENCODE_CONFIG_CONTENT, key not in argv", async () => {
      const dir = await setup("BOOF_RUNNER_OPENCODE_BIN", "opencode");
      const { env, argv } = await run(() => new OpencodeTool(), dir, { gateway: gw });
      const line = env.split("\n").find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="))!;
      expect(
        JSON.parse(line.slice("OPENCODE_CONFIG_CONTENT=".length)).provider.anthropic.options,
      ).toEqual({
        baseURL: "http://127.0.0.1:8080/v1",
        apiKey: "ccf-client-key",
      });
      expect(argv).not.toContain("ccf-client-key");
    });
  });

  it.skipIf(process.env.BOOF_REAL_CODEX !== "1")(
    "real codex routes to a local fake gateway with isolated homes",
    async () => {
      const temp = await mkdtemp(join(tmpdir(), "boof-real-codex-"));
      const home = join(temp, "home");
      const codexHome = join(temp, "codex");
      await import("node:fs/promises").then(({ mkdir }) =>
        Promise.all([mkdir(home), mkdir(codexHome)]),
      );
      const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
      const fake = createServer((req, res) => {
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
        });
        res
          .writeHead(401, { "content-type": "application/json" })
          .end('{"error":"smoke complete"}');
      });
      await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
      const gateway = `http://127.0.0.1:${(fake.address() as import("node:net").AddressInfo).port}`;
      const envNames = ["HOME", "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"];
      const original = Object.fromEntries(envNames.map((k) => [k, process.env[k]]));
      try {
        process.env.HOME = home;
        process.env.CODEX_HOME = codexHome;
        process.env.OPENAI_API_KEY = "inherited-provider-key-must-not-win";
        delete process.env.OPENAI_BASE_URL;
        const tool = new CodexTool();
        await expect(
          tool.run({
            role: "developer",
            model: "gpt-5.5",
            systemPrompt: "smoke",
            prompt: "smoke",
            cwd: temp,
            autoApprove: true,
            gateway: { url: gateway, apiKey: "btr-local-smoke-key" },
          }),
        ).rejects.toThrow();
        expect(
          requests.some(
            (r) =>
              r.method === "POST" &&
              r.url === "/v1/responses" &&
              r.authorization === "Bearer btr-local-smoke-key",
          ),
        ).toBe(true);
      } finally {
        for (const [k, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[k];
          else process.env[k] = value;
        }
        await new Promise<void>((resolve) => fake.close(() => resolve()));
        await rm(temp, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
