import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentEnv } from "./agent-env.js";
import { gatewayEnv } from "./gateway-env.js";
import { MockTool } from "./tools/mock.js";
import { ClaudeCodeTool } from "./tools/claude-code.js";
import { CodexTool } from "./tools/codex.js";
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
    CLAUDE_CODE_USE_BEDROCK: "1",
    OPENAI_API_KEY: "sk-oai",
    CODEX_HOME: "/home/u/.codex",
    OPENCODE_CONFIG: "/x",
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
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "OPENAI_API_KEY",
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
    ]) {
      expect(env, k).not.toHaveProperty(k);
    }
  });

  it("passes the names of runner.agentEnv through, but never a BOOF_ variable", () => {
    const env = agentEnv(server, ["GITHUB_TOKEN", "BOOF_KEY", "NOT_SET"]);
    expect(env.GITHUB_TOKEN).toBe("ghp");
    expect(env).not.toHaveProperty("BOOF_KEY");
    expect(env).not.toHaveProperty("NOT_SET");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
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
    set("AWS_SECRET_ACCESS_KEY", "aws-secret");
    set("EXTRA_PASS", "yes");
    set("ANTHROPIC_BASE_URL", "http://gateway.test");
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
    "%s: no BOOF_ or unrelated secret, the gateway variable and agentEnv names do",
    async (name, binVar, make) => {
      const dir = await envOf(binVar, name);
      try {
        await make().run({ ...base, cwd: dir, agentEnv: ["EXTRA_PASS"] });
      } catch {
        /* an empty answer may be refused; the child has run */
      }
      const env = await readFile(join(dir, "env"), "utf8");
      expect(env).not.toContain("BOOF_KEY");
      expect(env).not.toContain("BOOF_URL");
      expect(env).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(env).toContain("ANTHROPIC_BASE_URL=http://gateway.test");
      expect(env).toContain("EXTRA_PASS=yes");
      expect(env).toContain("PATH=");
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
    expect(gatewayEnv("anthropic", { url: "http://gw:8080" })).toEqual({
      ANTHROPIC_BASE_URL: "http://gw:8080",
    });
  });

  it("gatewayEnv: codex gets /v1 and a dummy key when none is set", () => {
    expect(gatewayEnv("openai", gw)).toEqual({
      OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      OPENAI_API_KEY: "ccf-client-key",
    });
    expect(gatewayEnv("openai", { url: "http://gw:8080" })).toEqual({
      OPENAI_BASE_URL: "http://gw:8080/v1",
      OPENAI_API_KEY: "dummy-key",
    });
  });

  it("gatewayEnv: opencode gets its provider options as config content", () => {
    const withKey = JSON.parse(gatewayEnv("opencode", gw).OPENCODE_CONFIG_CONTENT!);
    expect(withKey).toEqual({
      provider: {
        anthropic: { options: { baseURL: "http://127.0.0.1:8080", apiKey: "ccf-client-key" } },
      },
    });
    const noKey = JSON.parse(
      gatewayEnv("opencode", { url: "http://gw:8080" }).OPENCODE_CONFIG_CONTENT!,
    );
    expect(noKey.provider.anthropic.options).toEqual({ baseURL: "http://gw:8080" });
  });

  it("gatewayEnv: nothing without a gateway", () => {
    for (const kind of ["anthropic", "openai", "opencode"] as const) {
      expect(gatewayEnv(kind, undefined)).toEqual({});
    }
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

    it("claude without a gateway: the inherited environment is left alone", async () => {
      const dir = await setup("BOOF_RUNNER_CLAUDE_BIN", "claude");
      const { env } = await run(() => new ClaudeCodeTool(), dir, {});
      expect(env).toContain("ANTHROPIC_BASE_URL=http://inherited.test");
      expect(env).not.toContain("ANTHROPIC_AUTH_TOKEN");
    });

    it("claude with a gateway but no key: no token is invented", async () => {
      const dir = await setup("BOOF_RUNNER_CLAUDE_BIN", "claude");
      const { env } = await run(() => new ClaudeCodeTool(), dir, { gateway: { url: gw.url } });
      expect(env).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8080\n");
      expect(env).not.toContain("ANTHROPIC_AUTH_TOKEN");
    });

    it("codex: /v1 URL and key by env, config isolation kept, key not in argv", async () => {
      const dir = await setup("BOOF_RUNNER_CODEX_BIN", "codex");
      const { env, argv } = await run(() => new CodexTool(), dir, { gateway: gw });
      expect(env).toContain("OPENAI_BASE_URL=http://127.0.0.1:8080/v1\n");
      expect(env).toContain("OPENAI_API_KEY=ccf-client-key");
      expect(env).not.toContain("BOOF_");
      expect(argv).toContain("--ignore-user-config");
      expect(argv).not.toContain("ccf-client-key");
      const open = await run(() => new CodexTool(), dir, { gateway: gw, inheritMcpServers: true });
      expect(open.argv).not.toContain("--ignore-user-config");
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
        baseURL: "http://127.0.0.1:8080",
        apiKey: "ccf-client-key",
      });
      expect(argv).not.toContain("ccf-client-key");
    });
  });
});
