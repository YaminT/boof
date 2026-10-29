import type { TokenUsage } from "@boof-runner/shared";
import { commandExists, execCommand } from "../exec.js";
import type { HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import { ToolRunError } from "./errors.js";
import { parseUsage } from "./usage.js";

export { ToolRunError };

/**
 * Adapter for the `claude` CLI (Claude Code). Runs non-interactively with
 * `--output-format stream-json --include-partial-messages` so output arrives
 * token-by-token (plain `--print` buffers everything until exit). A
 * StreamRenderer turns the JSON event stream into readable text — assistant
 * text as it types, tool calls, and tool results — forwarded live via
 * `opts.onChunk`. Execution is scoped to `opts.cwd` (worktree-isolation spec).
 */
export class ClaudeCodeTool implements Tool {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly defaultModels = ["opus", "sonnet", "haiku"];
  private readonly bin = process.env.BOOF_RUNNER_CLAUDE_BIN ?? "claude";

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
    const model = (await this.listModels()).find((m) => m === "sonnet") ?? this.defaultModels[1];
    const probe = await execCommand(
      this.bin,
      ["--print", "--output-format", "text", "--model", model, "Reply with exactly: hi"],
      { cwd: process.cwd(), timeoutMs: 45000 },
    );
    if (probe.code !== 0 || probe.timedOut || !probe.stdout.trim()) {
      return {
        status: "unavailable",
        message: `claude CLI detected but auth probe failed: ${summarizeProbe(probe)}`,
        version: res.stdout.trim(),
      };
    }
    return {
      status: "available",
      message: `claude CLI authenticated via smoke prompt (${model})`,
      version: res.stdout.trim(),
    };
  }

  async listModels(): Promise<string[]> {
    if (!(await commandExists(this.bin))) return [...this.defaultModels];
    const res = await execCommand(this.bin, ["--help"], {
      cwd: process.cwd(),
      timeoutMs: 8000,
    });
    if (res.code !== 0) return [...this.defaultModels];
    return unique([...this.defaultModels, ...parseClaudeModelsFromHelp(res.stdout + res.stderr)]);
  }

  readonly supportsResume = true;

  /** Argument vector for `claude --print`; the prompt goes to stdin. */
  buildArgs(opts: RunOptions): string[] {
    // stream-json requires --verbose in --print mode; --include-partial-messages
    // adds token-level deltas for a live, CLI-like view.
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--model",
      opts.model,
      "--append-system-prompt",
      opts.systemPrompt,
    ];
    // Continue an earlier session (a steered step); the stdin prompt is the new message.
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.autoApprove) {
      // --dangerously-skip-permissions bypasses every tool-permission prompt.
      args.push("--dangerously-skip-permissions");
    }
    return args;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(opts);

    const render = new StreamRenderer((text) => opts.onChunk?.(text));
    const res = await execCommand(this.bin, args, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeoutMs: opts.timeoutMs,
      stopSignalPath: opts.stopSignalPath,
      steerSignalPath: opts.steerSignalPath,
      idleTimeoutMs: opts.idleTimeoutMs,
      onData: (chunk) => render.push(chunk),
    });
    render.flush();

    const header = `$ ${this.bin} --print --output-format stream-json --model ${opts.model}\n[exit ${res.code}]`;
    const output = `${header}\n${render.transcript}`;
    if (res.code !== 0 || res.timedOut || res.stopped || res.steered || res.stalled) {
      throw new ToolRunError(
        this.id,
        res.code,
        res.timedOut,
        res.stopped,
        `${output}\n${res.stderr}`,
        res.stderr,
        res.stalled,
        opts.idleTimeoutMs,
        { steered: res.steered, sessionId: render.sessionId, usage: render.usage },
      );
    }
    return {
      output,
      report: render.report || render.transcript.trim(),
      usage: render.usage ?? parseUsage(res.stdout),
      sessionId: render.sessionId,
    };
  }
}

function parseClaudeModelsFromHelp(text: string): string[] {
  const out: string[] = [];
  const quoted = /['"]([a-z0-9][a-z0-9._-]*)['"]/gi;
  for (let match = quoted.exec(text); match; match = quoted.exec(text)) {
    const value = match[1];
    if (/^(opus|sonnet|haiku|fable|claude-)/.test(value)) out.push(value);
  }
  return unique(out);
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

/**
 * Incremental renderer for the claude CLI's `stream-json` output. Each line of
 * stdout is one JSON event; we buffer partial lines, parse complete ones, and
 * emit human-readable text (assistant tokens, `⏺ Tool(arg)` calls, `⎿ result`
 * summaries) both live (via the callback) and into `transcript` for the record.
 */
export class StreamRenderer {
  transcript = "";
  report = "";
  usage?: TokenUsage;
  /** `session_id` of the `system`/`init` and `result` events: what `--resume` takes. */
  sessionId?: string;
  /** Per-message usage from `assistant` events, keyed by message id (fallback when no `result`). */
  private messageUsage = new Map<string, Record<string, unknown>>();
  private resultUsage = false;
  private buf = "";
  private blocks = new Map<number, { type?: string; name?: string; json: string }>();

  constructor(private readonly onText: (text: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }

  flush(): void {
    if (this.buf.trim()) this.handleLine(this.buf);
    this.buf = "";
  }

  private emit(text: string): void {
    if (!text) return;
    this.transcript += text;
    this.onText(text);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise
    }
    if (typeof obj.session_id === "string" && obj.session_id) this.sessionId = obj.session_id;
    switch (obj.type) {
      case "stream_event":
        this.streamEvent(obj.event as Record<string, unknown> | undefined);
        break;
      case "user":
        this.toolResult(obj.message as Record<string, unknown> | undefined);
        break;
      case "result":
        if (typeof obj.result === "string") this.report = obj.result;
        {
          const u = usageFromResult(obj);
          if (u) {
            this.usage = u;
            this.resultUsage = true;
          }
        }
        break;
      case "assistant":
        this.assistantUsage(obj.message as Record<string, unknown> | undefined);
        break;
      // "system" ignored: text already arrives via stream_event deltas.
    }
  }

  private assistantUsage(message?: Record<string, unknown>): void {
    const u = message?.usage as Record<string, unknown> | undefined;
    if (!u || this.resultUsage) return;
    // One message can be streamed as several events; the last one per id is authoritative.
    this.messageUsage.set(
      typeof message?.id === "string" ? message.id : `#${this.messageUsage.size}`,
      u,
    );
    this.usage = sumClaudeUsages([...this.messageUsage.values()], 0, false);
  }

  private streamEvent(ev?: Record<string, unknown>): void {
    if (!ev) return;
    if (ev.type === "content_block_start") {
      const cb = (ev.content_block as Record<string, unknown>) ?? {};
      const index = ev.index as number;
      this.blocks.set(index, { type: cb.type as string, name: cb.name as string, json: "" });
      if (cb.type === "tool_use") this.emit(`\n⏺ ${cb.name as string}`);
    } else if (ev.type === "content_block_delta") {
      const d = (ev.delta as Record<string, unknown>) ?? {};
      if (d.type === "text_delta") this.emit(d.text as string);
      else if (d.type === "input_json_delta") {
        const b = this.blocks.get(ev.index as number);
        if (b) b.json += (d.partial_json as string) ?? "";
      }
    } else if (ev.type === "content_block_stop") {
      const b = this.blocks.get(ev.index as number);
      if (b?.type === "tool_use") {
        const arg = firstArg(b.json);
        this.emit(arg ? `(${arg})\n` : "\n");
      } else if (b?.type === "text") {
        this.emit("\n");
      }
      this.blocks.delete(ev.index as number);
    }
  }

  private toolResult(message?: Record<string, unknown>): void {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part?.type !== "tool_result") continue;
      const text = toolResultText(part.content);
      if (text) this.emit(`  ⎿ ${truncate(text, 160)}\n`);
    }
  }
}

function firstArg(json: string): string {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const key = ["file_path", "path", "command", "pattern", "url", "query"].find(
      (k) => typeof obj[k] === "string",
    );
    return key ? truncate(String(obj[key]), 80) : "";
  } catch {
    return "";
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.split("\n")[0];
  if (Array.isArray(content)) {
    const first = content.find((c) => c?.type === "text");
    return first ? String(first.text).split("\n")[0] : "";
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Claude splits input into fresh, cache-creation and cache-read tokens; all count as input. */
function sumClaudeUsages(
  usages: Record<string, unknown>[],
  costUsd: number,
  known: boolean,
): TokenUsage {
  let fresh = 0;
  let created = 0;
  let read = 0;
  let outputTokens = 0;
  for (const u of usages) {
    fresh += num(u.input_tokens);
    created += num(u.cache_creation_input_tokens);
    read += num(u.cache_read_input_tokens);
    outputTokens += num(u.output_tokens);
  }
  return {
    inputTokens: fresh + created + read,
    outputTokens,
    costUsd,
    known,
  };
}

function usageFromResult(obj: Record<string, unknown>): TokenUsage | undefined {
  const u = obj.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  return sumClaudeUsages([u], num(obj.total_cost_usd), typeof obj.total_cost_usd === "number");
}
