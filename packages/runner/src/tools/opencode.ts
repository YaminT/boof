import { commandExists, execCommand } from "../exec.js";
import { ToolRunError } from "./errors.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { JsonlRenderer, num, obj, oneLine, parseJsonLine, str, stripAnsi } from "./jsonl.js";
import { parseUsage } from "./usage.js";
import { withQuestions } from "./questions.js";
import type { TokenUsage } from "@boof-runner/shared";

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

  readonly supportsResume = true;

  /** Argument vector for `opencode run`; exported through the class for tests. */
  buildArgs(opts: RunOptions): string[] {
    // Anchor the project to opts.cwd explicitly: without --dir, opencode
    // canonicalizes a git worktree cwd back to the main repository and its
    // file tools (Read/Write/Edit) would bypass the runner's isolation.
    const args = ["run", "--format", "json", "--dir", opts.cwd, "-m", opts.model];
    // Continue an earlier session (a steered step): the prompt is then only the new message.
    if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId);
    if (opts.autoApprove) {
      // Auto-approve permissions that are not explicitly denied: the
      // runner's equivalent of codex's bypass flag.
      args.push("--auto");
    }
    return args;
  }

  /** The text fed on stdin: the new message alone on resume, else system prompt + prompt. */
  promptText(opts: RunOptions): string {
    return opts.resumeSessionId ? opts.prompt : `${opts.systemPrompt}\n\n${opts.prompt}`;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(opts);
    const live = new JsonlRenderer(renderOpencodeEvent, opts.onChunk);
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
    const summary = summarizeOpencodeStream(res.stdout);
    const output = `$ ${this.bin} ${args.join(" ")} <prompt>\n[exit ${res.code}]\n${summary.rendered}\n${stripAnsi(res.stderr)}`;
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
    // No JSON events (older CLI, plain output): fall back to ANSI-stripped text.
    const plain = stripAnsi(res.stdout).trim();
    return withQuestions({
      output,
      report: summary.report || plain,
      usage: summary.usage ?? parseUsage(plain + "\n" + stripAnsi(res.stderr)),
      sessionId: summary.sessionId,
    });
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

/** One readable line (or "") for an `opencode run --format json` event. */
export function renderOpencodeEvent(ev: Record<string, unknown>): string {
  const type = str(ev.type);
  const part = obj(ev.part);
  switch (type) {
    case "text":
      return str(part.text);
    case "reasoning":
      return str(part.text) ? `[thinking] ${oneLine(str(part.text))}` : "";
    case "tool_use":
    case "tool":
      return renderTool(part);
    case "step_start":
    case "step_finish":
      return "";
    case "error": {
      const e = obj(ev.error);
      const msg = str(obj(e.data).message) || str(e.message) || str(e.name);
      return `[error] ${oneLine(msg, 300)}`;
    }
    default:
      return type ? `[${type}]` : "";
  }
}

function renderTool(part: Record<string, unknown>): string {
  const state = obj(part.state);
  const status = str(state.status);
  // Report a tool once it settles; pending/running states would only duplicate it.
  if (status && status !== "completed" && status !== "error") return "";
  const input = obj(state.input);
  const arg =
    str(input.command) ||
    str(input.filePath) ||
    str(input.path) ||
    str(input.pattern) ||
    str(input.url) ||
    str(state.title);
  const line = `[${str(part.tool) || "tool"}]${arg ? " " + oneLine(arg) : ""}`;
  return status === "error" ? `${line} (failed)` : line;
}

/** Fold a complete `--format json` stdout into the final message, usage and a readable log. */
export function summarizeOpencodeStream(stdout: string): {
  report: string;
  usage: TokenUsage | null;
  rendered: string;
  /** `sessionID` carried by the events: what `opencode run --session` takes. */
  sessionId?: string;
} {
  const r = new JsonlRenderer(renderOpencodeEvent);
  let sessionId: string | undefined;
  r.push(stdout);
  r.flush();
  const texts: { messageId: string; text: string }[] = [];
  let input = 0;
  let output = 0;
  let cost = 0;
  let seen = false;
  let priced = false;
  for (const line of stdout.split("\n")) {
    const ev = parseJsonLine(line);
    if (!ev) continue;
    const part = obj(ev.part);
    sessionId = sessionId ?? (str(ev.sessionID) || str(part.sessionID) || undefined);
    if (ev.type === "text" && str(part.text)) {
      texts.push({ messageId: str(part.messageID), text: str(part.text) });
    } else if (ev.type === "step_finish") {
      const t = obj(part.tokens);
      const cache = obj(t.cache);
      // Cached input counts as input, as in the claude-code adapter.
      input += num(t.input) + num(cache.read) + num(cache.write);
      output += num(t.output) + num(t.reasoning);
      cost += num(part.cost);
      priced ||= typeof part.cost === "number";
      seen = true;
    }
  }
  const lastId = texts.at(-1)?.messageId;
  const last = texts.filter((t) => t.messageId === lastId);
  const report = (last.length ? last : texts)
    .map((t) => t.text)
    .join("\n")
    .trim();
  return {
    report,
    usage: seen ? { inputTokens: input, outputTokens: output, costUsd: cost, known: priced } : null,
    rendered: r.text.trimEnd(),
    sessionId,
  };
}
