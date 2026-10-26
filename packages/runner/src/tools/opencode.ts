import { commandExists, execCommand } from "../exec.js";
import { ToolRunError } from "./errors.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { parseUsage } from "./usage.js";

/**
 * Adapter for the `opencode` CLI. Runs non-interactively via `opencode run`;
 * in auto mode passes `--auto` (auto-approve permissions not explicitly
 * denied). Scoped to `opts.cwd`.
 */
export class OpencodeTool implements Tool {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly defaultModels = ["opencode-go/kimi-k3"];
  private readonly bin = process.env.BOOF_RUNNER_OPENCODE_BIN ?? "opencode";

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
    const probe = await execCommand(this.bin, ["run", "-m", model, "Reply with exactly: hi"], {
      cwd: process.cwd(),
      timeoutMs: 90000,
    });
    if (probe.code !== 0 || probe.timedOut || !probe.stdout.trim()) {
      return {
        status: "unavailable",
        message: `opencode CLI detected but probe failed: ${summarizeProbe(probe)}`,
        version: res.stdout.trim(),
      };
    }
    return {
      status: "available",
      message: `opencode CLI answered smoke prompt (${model})`,
      version: res.stdout.trim(),
    };
  }

  async listModels(): Promise<string[]> {
    if (!(await commandExists(this.bin))) return [...this.defaultModels];
    const res = await execCommand(this.bin, ["models"], {
      cwd: process.cwd(),
      timeoutMs: 20000,
    });
    if (res.code !== 0) return [...this.defaultModels];
    // `opencode models` prints one `provider/model` id per line.
    const models = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("/"));
    return unique(models.length ? models : this.defaultModels);
  }

  /** Argument vector for `opencode run`; exported through the class for tests. */
  buildArgs(opts: RunOptions): string[] {
    // Anchor the project to opts.cwd explicitly: without --dir, opencode
    // canonicalizes a git worktree cwd back to the main repository and its
    // file tools (Read/Write/Edit) would bypass the runner's isolation.
    const args = ["run", "--dir", opts.cwd, "-m", opts.model];
    if (opts.autoApprove) {
      // Auto-approve permissions that are not explicitly denied: the
      // runner's equivalent of codex's bypass flag.
      args.push("--auto");
    }
    args.push(`${opts.systemPrompt}\n\n${opts.prompt}`);
    return args;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(opts);
    const res = await execCommand(this.bin, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      stopSignalPath: opts.stopSignalPath,
      idleTimeoutMs: opts.idleTimeoutMs,
      onData: opts.onChunk,
    });
    const output = `$ ${this.bin} ${args.slice(0, -1).join(" ")} <prompt>\n[exit ${res.code}]\n${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || res.timedOut || res.stopped || res.stalled) {
      throw new ToolRunError(
        this.id,
        res.code,
        res.timedOut,
        res.stopped,
        output,
        res.stderr,
        res.stalled,
        opts.idleTimeoutMs,
      );
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
