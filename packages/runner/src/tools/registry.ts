import { ClaudeCodeTool } from "./claude-code.js";
import { CodexTool } from "./codex.js";
import { MockTool } from "./mock.js";
import type { HealthResult, Tool } from "./types.js";

/**
 * Registry of available tools. New tools register here without the pipeline
 * needing to know their concrete types (tool-adapters spec).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

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

  /** Run every tool's health check; returns id → result. */
  async healthAll(): Promise<Record<string, HealthResult>> {
    const out: Record<string, HealthResult> = {};
    await Promise.all(
      this.list().map(async (t) => {
        try {
          out[t.id] = await t.detect();
        } catch (err) {
          out[t.id] = { status: "unavailable", message: String(err) };
        }
      }),
    );
    return out;
  }

  /** Fetch current model lists from every tool, falling back to built-in defaults. */
  async modelsAll(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    await Promise.all(
      this.list().map(async (t) => {
        try {
          const models = await t.listModels();
          out[t.id] = models.length ? models : [...t.defaultModels];
        } catch {
          out[t.id] = [...t.defaultModels];
        }
      }),
    );
    return out;
  }
}

export function defaultTools(): Tool[] {
  return [new ClaudeCodeTool(), new CodexTool(), new MockTool()];
}
