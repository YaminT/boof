import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentEnv } from "./agent-env.js";
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
