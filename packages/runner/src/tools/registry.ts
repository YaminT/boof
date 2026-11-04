import { ClaudeCodeTool } from "./claude-code.js";
import { CodexTool } from "./codex.js";
import { MockTool } from "./mock.js";
import { OpencodeTool } from "./opencode.js";
import type { CachedHealth, HealthResult, ToolCatalog } from "@boof/heart";
import type { DetectOptions, Tool } from "./types.js";

export type { CachedHealth } from "@boof/heart";

/**
 * Registry of available tools. New tools register here without the pipeline
 * needing to know their concrete types (tool-adapters spec).
 */
export class ToolRegistry implements ToolCatalog {
  private readonly tools = new Map<string, Tool>();
  /** Last health result per tool id, written by {@link healthAll}. */
  private readonly healthCache = new Map<string, CachedHealth>();
  /** Last live model list per tool id, written by {@link liveModels}. */
  private readonly modelCache = new Map<string, string[]>();

  constructor(tools: Tool[] = defaultTools()) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  require(id: string): Tool {
    const t = this.tools.get(id);
    if (!t) throw new Error(`Unknown tool: ${id}`);
    return t;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** The check in progress, shared by every caller that arrives meanwhile. */
  private healthInFlight: Promise<Record<string, HealthResult>> | undefined;
  private liveInFlight: Promise<Record<string, string[]>> | undefined;

  /**
   * Run every tool's health check (each one sends a short, paid prompt) unless the last check is
   * younger than `maxAgeMs`, and share one check between concurrent callers. Returns id → result.
   */
  healthAll(maxAgeMs = 0, detect: DetectOptions = {}): Promise<Record<string, HealthResult>> {
    if (this.healthInFlight) return this.healthInFlight;
    const cached = this.lastHealth();
    const ids = this.list().map((t) => t.id);
    if (
      maxAgeMs > 0 &&
      ids.length > 0 &&
      ids.every((id) => {
        const c = cached[id];
        return c !== undefined && Date.now() - Date.parse(c.checkedAt) < maxAgeMs;
      })
    ) {
      return Promise.resolve(
        Object.fromEntries(ids.map((id) => [id, withoutTime(cached[id])])) as Record<
          string,
          HealthResult
        >,
      );
    }
    const run = this.runHealth(detect).finally(() => {
      this.healthInFlight = undefined;
    });
    this.healthInFlight = run;
    return run;
  }

  private async runHealth(detect: DetectOptions): Promise<Record<string, HealthResult>> {
    const out: Record<string, HealthResult> = {};
    await Promise.all(
      this.list().map(async (t) => {
        let result: HealthResult;
        try {
          result = await t.detect(detect);
        } catch (err) {
          result = { status: "unavailable", message: String(err) };
        }
        out[t.id] = result;
        this.healthCache.set(t.id, { ...result, checkedAt: new Date().toISOString() });
      }),
    );
    return out;
  }

  /** Last cached health result per tool id; a tool is absent until a health check ran in this process. */
  lastHealth(): Record<string, CachedHealth> {
    return Object.fromEntries(this.healthCache);
  }

  /**
   * Models each tool's listModels() returns now (runs the tools); empty for a tool whose listing
   * failed or was empty. Remembered for {@link cachedLiveModels}.
   */
  liveModels(): Promise<Record<string, string[]>> {
    if (this.liveInFlight) return this.liveInFlight;
    const run = this.runLiveModels().finally(() => {
      this.liveInFlight = undefined;
    });
    this.liveInFlight = run;
    return run;
  }

  private async runLiveModels(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    await Promise.all(
      this.list().map(async (t) => {
        try {
          out[t.id] = await t.listModels();
        } catch {
          out[t.id] = [];
        }
        this.modelCache.set(t.id, out[t.id]);
      }),
    );
    return out;
  }

  /** The lists the last {@link liveModels} found, without running a tool; a tool not asked yet maps to []. */
  cachedLiveModels(): Record<string, string[]> {
    return Object.fromEntries(
      this.list().map((t) => [t.id, [...(this.modelCache.get(t.id) ?? [])]]),
    );
  }

  /** Fetch current model lists from every tool (runs them), falling back to built-in defaults. */
  async modelsAll(): Promise<Record<string, string[]>> {
    return this.withDefaults(await this.liveModels());
  }

  /** The last fetched model lists (or the built-in defaults), without running a tool. */
  cachedModels(): Record<string, string[]> {
    return this.withDefaults(this.cachedLiveModels());
  }

  private withDefaults(live: Record<string, string[]>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const t of this.list()) {
      const models = live[t.id] ?? [];
      out[t.id] = models.length ? models : [...t.defaultModels];
    }
    return out;
  }
}

export function defaultTools(): Tool[] {
  return [new ClaudeCodeTool(), new CodexTool(), new MockTool(), new OpencodeTool()];
}

function withoutTime(c: CachedHealth): HealthResult {
  const { checkedAt: _checkedAt, ...rest } = c;
  return rest;
}
