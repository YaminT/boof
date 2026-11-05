import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await expect(
      resolveClaudeAgentExecutable({ BOOF_RUNNER_CLAUDE_AGENT_BIN: executable }),
    ).resolves.toEqual({
      path: executable,
      source: "env",
    });
  });

  it("falls back to PATH after the SDK binary cannot be resolved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-path-"));
    tempDirs.push(dir);
    const executable = join(dir, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await expect(
      resolveClaudeAgentExecutable(
        { PATH: dir },
        {
          sdkResolve: () => {
            throw new Error("no SDK");
          },
          requireResolve: () => {
            throw new Error("missing");
          },
        },
      ),
    ).resolves.toEqual({ path: executable, source: "path" });
  });

  it("rejects a directory named claude on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-directory-"));
    tempDirs.push(dir);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(dir, "claude")));
    await expect(
      resolveClaudeAgentExecutable(
        { PATH: dir },
        {
          sdkResolve: () => {
            throw new Error("no SDK");
          },
        },
      ),
    ).resolves.toEqual({ path: undefined, source: null });
  });

  it("resolves a configured relative path with a separator from cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-relative-"));
    tempDirs.push(dir);
    const executable = join(dir, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const relativePath = relative(process.cwd(), executable);
    await expect(
      resolveClaudeAgentExecutable(
        { BOOF_RUNNER_CLAUDE_BIN: relativePath, PATH: "" },
        {
          sdkResolve: () => {
            throw new Error("no SDK");
          },
        },
      ),
    ).resolves.toEqual({ path: executable, source: "path" });
  });

  it("does not append .EXE to a configured Windows executable path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-win-"));
    tempDirs.push(dir);
    const executable = join(dir, "claude.exe");
    await writeFile(executable, "binary");
    await expect(
      resolveClaudeAgentExecutable(
        { BOOF_RUNNER_CLAUDE_BIN: executable, PATH: "" },
        {
          platform: "win32",
          sdkResolve: () => {
            throw new Error("no SDK");
          },
        },
      ),
    ).resolves.toEqual({ path: executable, source: "path" });
  });

  it("reports no executable when every source is missing", async () => {
    await expect(
      resolveClaudeAgentExecutable(
        {},
        {
          sdkResolve: () => {
            throw new Error("no SDK");
          },
          requireResolve: () => {
            throw new Error("missing");
          },
        },
      ),
    ).resolves.toEqual({ path: undefined, source: null });
  });

  it("finds the optional binary in the real installed SDK tree", async (ctx) => {
    const sdkEntry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    let binaryInstalled = false;
    const platform = process.platform;
    const libcVariants =
      platform === "linux"
        ? process.report?.getReport().header.glibcVersionRuntime
          ? ["", "-musl"]
          : ["-musl", ""]
        : [""];
    if (platform === "linux" || platform === "darwin" || platform === "win32") {
      for (const variant of libcVariants) {
        const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}${variant}`;
        try {
          const path = sdkRequire.resolve(
            `${packageName}/${platform === "win32" ? "claude.exe" : "claude"}`,
          );
          if (existsSync(path)) binaryInstalled = true;
        } catch {
          // A package for a different libc may be the installed optional binary.
        }
      }
    }
    if (!binaryInstalled)
      ctx.skip("optional platform binary is genuinely not installed in this node_modules tree");
    const result = await resolveClaudeAgentExecutable({ PATH: "" });
    expect(result).toEqual({ path: undefined, source: "sdk" });
  });

  it("tries musl then glibc when musl is detected", async () => {
    const seen: string[] = [];
    await resolveClaudeAgentExecutable(
      {},
      {
        platform: "linux",
        arch: "x64",
        musl: true,
        sdkResolve: () => "/sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
        requireResolve: (specifier) => {
          seen.push(specifier);
          if (specifier.endsWith("-musl/claude")) return "/sdk/musl/claude";
          throw new Error("missing");
        },
      },
    );
    expect(seen.slice(0, 2)).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ]);
  });

  it("returns a visible failure for a configured non-executable override", async () => {
    await expect(
      resolveClaudeAgentExecutable({ BOOF_RUNNER_CLAUDE_AGENT_BIN: "/missing/claude" }),
    ).resolves.toMatchObject({ path: undefined, source: null, reason: expect.any(String) });
  });

  it("hides import failure details", async () => {
    const importer = vi.fn(async () => {
      throw new Error("private path detail");
    });
    const rejection = loadAgentSdk(importer);
    await expect(rejection).rejects.toThrow(
      "the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) failed to load",
    );
    await expect(rejection).rejects.not.toThrow("private path detail");
  });

  it("distinguishes an absent SDK from a different load failure", async () => {
    await expect(
      loadAgentSdk(async () => {
        const e = new Error("hidden");
        Object.assign(e, { code: "ERR_MODULE_NOT_FOUND" });
        throw e;
      }),
    ).rejects.toThrow("is not installed");
    await expect(
      loadAgentSdk(async () => {
        throw new SyntaxError("hidden");
      }),
    ).rejects.toThrow("failed to load");
  });
});
