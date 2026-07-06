import { commandExists, execCommand } from "../exec.js";
import { ToolRunError } from "./claude-code.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { parseUsage } from "./usage.js";

/**
 * Adapter for the `codex` CLI. Runs non-interactively via `exec`; in auto mode
 * uses full-auto / bypass sandbox flags. Scoped to `opts.cwd`.
 */
export class CodexTool implements Tool {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly defaultModels = ["gpt-5.5"];
  private readonly bin = process.env.BOOF_RUNNER_CODEX_BIN ?? "codex";

  async detect(): Promise<HealthResult> {
    if (!(await commandExists(this.bin))) {
      return { status: "unavailable", message: `\`${this.bin}\` not found on PATH` };
    }
    const res = await execCommand(this.bin, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 8000,
    });
    if (res.code !== 0) {
      return { status: "unavailable", message: `\`${this.bin} --version\` exited ${res.code}` };
    }
    const model = (await this.listModels())[0] ?? this.defaultModels[0];
    const probe = await execCommand(
      this.bin,
      ["exec", "--model", model, "Reply with exactly: hi"],
      {
        cwd: process.cwd(),
        timeoutMs: 60000,
      },
    );
    if (probe.code !== 0 || probe.timedOut || !probe.stdout.trim()) {
      return {
        status: "unavailable",
        message: `codex CLI detected but auth probe failed: ${summarizeProbe(probe)}`,
        version: res.stdout.trim(),
      };
    }
    return {
      status: "available",
      message: `codex CLI authenticated via smoke prompt (${model})`,
      version: res.stdout.trim(),
    };
  }

  async listModels(): Promise<string[]> {
    if (!(await commandExists(this.bin))) return [...this.defaultModels];
    const res = await execCommand(this.bin, ["debug", "models"], {
      cwd: process.cwd(),
      timeoutMs: 20000,
    });
    if (res.code !== 0) return [...this.defaultModels];
    try {
      const catalog = JSON.parse(res.stdout) as { models?: unknown[] };
      const slugs = (catalog.models ?? [])
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .filter((m) => m.visibility !== "hide")
        .map((m) => m.slug ?? m.id ?? m.name)
        .filter((m): m is string => typeof m === "string" && m.trim().length > 0);
      return unique(slugs.length ? slugs : this.defaultModels);
    } catch {
      return [...this.defaultModels];
    }
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = ["exec", "--model", opts.model];
    if (opts.autoApprove) {
      // Full auto-approval, no sandbox — the runner's equivalent of claude's
      // --dangerously-skip-permissions. Mutually exclusive with --full-auto
      // (codex rejects both together), so pass only the bypass flag.
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(`${opts.systemPrompt}\n\n${opts.prompt}`);

    const res = await execCommand(this.bin, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      stopSignalPath: opts.stopSignalPath,
      onData: opts.onChunk,
    });
    const output = `$ ${this.bin} ${args.slice(0, -1).join(" ")} <prompt>\n[exit ${res.code}]\n${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || res.timedOut || res.stopped) {
      throw new ToolRunError(this.id, res.code, res.timedOut, res.stopped, output);
    }
    return { output, report: res.stdout.trim(), usage: parseUsage(res.stdout + res.stderr) };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function summarizeProbe(res: {
  code: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}): string {
  if (res.timedOut) return "timed out waiting for answer";
  const detail = (res.stderr || res.stdout).trim().replace(/\s+/g, " ");
  return detail
    ? `exit ${res.code ?? "null"} - ${truncate(detail, 180)}`
    : `exit ${res.code ?? "null"}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
