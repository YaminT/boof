import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentSdk, resolveClaudeAgentExecutable } from "./claude-agent-sdk.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Claude Agent SDK loading", () => {
  it("uses an explicitly configured executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-sdk-"));
    tempDirs.push(dir);
    const executable = join(dir, "claude");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(executable, "#!/bin/sh\nexit 0\n"),
    );
    await chmod(executable, 0o755);
    await expect(
      resolveClaudeAgentExecutable({ BOOF_RUNNER_CLAUDE_AGENT_BIN: executable }),
    ).resolves.toEqual({
      path: executable,
      source: "env",
    });
  });

  it("falls back to PATH after the SDK binary cannot be resolved", async () => {
    await expect(
      resolveClaudeAgentExecutable(
        {},
        {
          requireResolve: () => {
            throw new Error("missing");
          },
          commandExists: async () => true,
        },
      ),
    ).resolves.toEqual({ path: undefined, source: "path" });
  });

  it("reports no executable when every source is missing", async () => {
    await expect(
      resolveClaudeAgentExecutable(
        {},
        {
          requireResolve: () => {
            throw new Error("missing");
          },
          commandExists: async () => false,
        },
      ),
    ).resolves.toEqual({ path: undefined, source: null });
  });

  it("hides import failure details", async () => {
    const importer = vi.fn(async () => {
      throw new Error("private path detail");
    });
    const rejection = loadAgentSdk(importer);
    await expect(rejection).rejects.toThrow(
      "the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed",
    );
    await expect(rejection).rejects.not.toThrow("private path detail");
  });
});
