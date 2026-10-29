import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, execCommand } from "../exec.js";
import { ToolRunError } from "./errors.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { JsonlRenderer, num, obj, oneLine, parseJsonLine, str } from "./jsonl.js";
import { parseUsage } from "./usage.js";
import { withQuestions } from "./questions.js";
import type { TokenUsage } from "@boof-runner/shared";

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
      // The probe runs outside any repository (the server's cwd); codex refuses
      // that without --skip-git-repo-check. Empty stdin so it never waits for input.
      ["exec", "--skip-git-repo-check", "--model", model, "Reply with exactly: hi"],
      {
        cwd: process.cwd(),
        input: "",
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

  readonly supportsResume = true;

  /**
   * Argument vector for `codex exec`, last entry `-`: the prompt is read from stdin. With `resumeSessionId` it is
   * `codex exec resume <thread id> ...`, which takes the same flags and a message only (the
   * resumed thread already holds the system prompt).
   */
  buildArgs(opts: RunOptions, lastMessageFile: string): string[] {
    // --json: stdout becomes a JSONL event stream (structured usage and messages).
    const args = opts.resumeSessionId
      ? ["exec", "resume", opts.resumeSessionId, "--json", "--model", opts.model]
      : ["exec", "--json", "--model", opts.model];
    if (opts.autoApprove) {
      // Full auto-approval, no sandbox — the runner's equivalent of claude's
      // --dangerously-skip-permissions. Mutually exclusive with --full-auto
      // (codex rejects both together), so pass only the bypass flag.
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    // Ask codex to write its final message to a file outside cwd: stdout also
    // carries progress and usage noise that would break verdict parsing.
    args.push("-o", lastMessageFile);
    args.push("-");
    return args;
  }

  /** The text fed on stdin: the new message alone on resume, else system prompt + prompt. */
  promptText(opts: RunOptions): string {
    return opts.resumeSessionId ? opts.prompt : `${opts.systemPrompt}\n\n${opts.prompt}`;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const dir = await mkdtemp(join(tmpdir(), "boof-codex-"));
    const last = join(dir, "last-message.txt");
    const args = this.buildArgs(opts, last);

    try {
      // Live view: JSON events become readable lines; anything else passes through.
      const live = new JsonlRenderer(renderCodexEvent, opts.onChunk);
      const res = await execCommand(this.bin, args, {
        cwd: opts.cwd,
        input: this.promptText(opts),
        timeoutMs: opts.timeoutMs,
        stopSignalPath: opts.stopSignalPath,
        steerSignalPath: opts.steerSignalPath,
        idleTimeoutMs: opts.idleTimeoutMs,
        onData: opts.onChunk ? (c) => live.push(c) : undefined,
      });
      live.flush();
      const summary = summarizeCodexStream(res.stdout);
      const output = `$ ${this.bin} ${args.slice(0, -1).join(" ")} <prompt>\n[exit ${res.code}]\n${summary.rendered}\n${res.stderr}`;
      if (res.code !== 0 || res.timedOut || res.stopped || res.steered || res.stalled) {
        throw new ToolRunError(
          this.id,
          res.code,
          res.timedOut,
          res.stopped,
          output,
          res.stderr,
          res.stalled,
          opts.idleTimeoutMs,
          {
            steered: res.steered,
            sessionId: summary.sessionId,
            usage: summary.usage ?? undefined,
          },
        );
      }
      const message = await readFile(last, "utf8").catch(() => "");
      const report = message.trim() || summary.lastMessage || res.stdout.trim();
      // Structured usage from turn.completed; fall back to scanning plain text
      // ("tokens used" on stderr) when no JSON events were emitted.
      const usage = summary.usage ?? parseUsage(res.stdout + res.stderr);
      return withQuestions({ output, report, usage, sessionId: summary.sessionId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

/** One readable line (or "") for a `codex exec --json` event. */
export function renderCodexEvent(ev: Record<string, unknown>): string {
  const type = str(ev.type);
  if (type === "item.completed" || type === "item.started") {
    const item = obj(ev.item);
    const t = str(item.type);
    const done = type === "item.completed";
    switch (t) {
      case "agent_message":
        return done ? str(item.text) : "";
      case "reasoning":
        return done && str(item.text) ? `[thinking] ${oneLine(str(item.text))}` : "";
      case "command_execution": {
        if (!done) return "";
        const code = item.exit_code;
        return `$ ${oneLine(str(item.command))}${typeof code === "number" ? ` (exit ${code})` : ""}`;
      }
      case "file_change": {
        if (!done) return "";
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const list = changes.map((c) => `${str(obj(c).kind)} ${str(obj(c).path)}`.trim());
        return `[files] ${oneLine(list.join(", ") || "changed")}`;
      }
      case "mcp_tool_call":
        return done ? `[tool] ${str(item.server)}/${str(item.tool)}` : "";
      case "web_search":
        return done ? `[search] ${oneLine(str(item.query))}` : "";
      case "error":
        return `[warning] ${oneLine(str(item.message), 300)}`;
      default:
        return done ? `[${t || "item"}]` : "";
    }
  }
  if (type === "turn.failed" || type === "error") {
    const msg = str(obj(ev.error).message) || str(ev.message);
    return `[error] ${oneLine(msg, 300)}`;
  }
  return "";
}

/** Fold a complete `--json` stdout into the last agent message, usage and a readable log. */
export function summarizeCodexStream(stdout: string): {
  lastMessage: string;
  usage: TokenUsage | null;
  rendered: string;
  /** `thread_id` of the `thread.started` event: what `codex exec resume` takes. */
  sessionId?: string;
} {
  const r = new JsonlRenderer(renderCodexEvent);
  let sessionId: string | undefined;
  r.push(stdout);
  r.flush();
  let lastMessage = "";
  let input = 0;
  let output = 0;
  let seen = false;
  for (const line of stdout.split("\n")) {
    const ev = parseJsonLine(line);
    if (!ev) continue;
    if (ev.type === "thread.started" && str(ev.thread_id)) {
      sessionId = sessionId ?? str(ev.thread_id);
    } else if (ev.type === "item.completed") {
      const item = obj(ev.item);
      if (item.type === "agent_message" && str(item.text).trim()) lastMessage = str(item.text);
    } else if (ev.type === "turn.completed") {
      const u = obj(ev.usage);
      // OpenAI semantics: input_tokens already includes cached input, and
      // output_tokens already includes reasoning, so neither is added again.
      input += num(u.input_tokens);
      output += num(u.output_tokens);
      seen = true;
    }
  }
  return {
    lastMessage: lastMessage.trim(),
    usage: seen ? { inputTokens: input, outputTokens: output, costUsd: 0, known: false } : null,
    rendered: r.text.trimEnd(),
    sessionId,
  };
}
