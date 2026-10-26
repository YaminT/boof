import { ClaudeCodeTool } from "./claude-code.js";
import { CodexTool } from "./codex.js";
import { MockTool } from "./mock.js";
import { OpencodeTool } from "./opencode.js";
import type { HealthResult, Tool } from "./types.js";

/** A health result plus when it was computed in this server process. */
export interface CachedHealth extends HealthResult {
  checkedAt: string;
}

/**
 * Registry of available tools. New tools register here without the pipeline
 * needing to know their concrete types (tool-adapters spec).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  /** Last health result per tool id, written by {@link healthAll}. */
  private readonly healthCache = new Map<string, CachedHealth>();

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

  /** Run every tool's health check; returns id → result and caches each result with its time. */
  async healthAll(): Promise<Record<string, HealthResult>> {
    const out: Record<string, HealthResult> = {};
    await Promise.all(
      this.list().map(async (t) => {
        let result: HealthResult;
        try {
          result = await t.detect();
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

  /** Models each tool's listModels() returns now; empty for a tool whose listing failed or was empty. */
  async liveModels(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    await Promise.all(
      this.list().map(async (t) => {
        try {
          out[t.id] = await t.listModels();
        } catch {
          out[t.id] = [];
        }
      }),
    );
    return out;
  }

  /** Fetch current model lists from every tool, falling back to built-in defaults. */
  async modelsAll(): Promise<Record<string, string[]>> {
    const live = await this.liveModels();
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
