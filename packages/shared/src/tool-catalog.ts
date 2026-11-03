/**
 * What Heart (the server, the operations, MCP) knows about the coding-agent tools, without
 * knowing any of them. Runner's `ToolRegistry` implements `ToolCatalog`; the composition roots (bin,
 * desktop) construct it and hand it to `TaskService`, `startServer` and `runStdio`. Heart never
 * builds a registry itself, so it never depends on the engine or the tool adapters.
 */

export type HealthStatus = "available" | "unavailable";

export interface HealthResult {
  status: HealthStatus;
  /** Human-readable detail for the settings health-check UI. */
  message: string;
  /** Resolved version string when available. */
  version?: string;
}

/** A health result plus when it was computed in this server process. */
export interface CachedHealth extends HealthResult {
  checkedAt: string;
}

/** The public face of one tool: enough to list it and to name its models. */
export interface ToolInfo {
  id: string;
  displayName: string;
  defaultModels: readonly string[];
  supportsResume?: boolean;
}

export interface HealthOptions {
  /** Let the probe load the user's own MCP servers (`runner.inheritMcpServers`); default false. */
  inheritMcpServers?: boolean;
}

/**
 * The catalog of tools. The checks and model listings spawn the tools (a health check sends a
 * short, paid prompt), so the `cached*`/`last*` readers exist for GET routes, which must not.
 */
export interface ToolCatalog {
  list(): readonly ToolInfo[];
  get(id: string): ToolInfo | undefined;
  /**
   * Run every tool's health check, unless the last one is younger than `maxAgeMs`; concurrent
   * callers share one check. Returns id → result.
   */
  healthAll(
    maxAgeMs?: number,
    opts?: HealthOptions,
  ): Promise<Readonly<Record<string, Readonly<HealthResult>>>>;
  /** Last health result per tool id of this process, without running a tool. */
  lastHealth(): Readonly<Record<string, Readonly<CachedHealth>>>;
  /** Models each tool lists now (runs the tools), falling back to the built-in defaults. */
  modelsAll(): Promise<Readonly<Record<string, readonly string[]>>>;
  /** The last fetched model lists (or the built-in defaults), without running a tool. */
  cachedModels(): Readonly<Record<string, readonly string[]>>;
  /** The lists the last live listing found, without running a tool; a tool not asked yet maps to []. */
  cachedLiveModels(): Readonly<Record<string, readonly string[]>>;
}
