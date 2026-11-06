import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSdk } from "./claude-agent-sdk.js";

export type FakeStep =
  | "hang"
  | { emit: unknown }
  | { interruptResult: unknown }
  | { callMcp: string; args: Record<string, unknown> };

export type McpCallRecord = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
};

type McpClient = {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

/** The MCP SDK already used by heart-server. Runner does not take a new dependency on it. */
export function loadMcpSdk(): {
  Client: new (info: { name: string; version: string }) => McpClient;
  InMemoryTransport: { createLinkedPair(): [unknown, unknown] };
  McpServer: new (info: { name: string; version: string }) => {
    connect(transport: unknown): Promise<void>;
    registerTool(name: string, config: object, cb: (args: never) => unknown): unknown;
  };
} {
  const require = createRequire(heartServerPackageJson());
  const client = require("@modelcontextprotocol/sdk/client/index.js") as {
    Client: new (info: { name: string; version: string }) => McpClient;
  };
  const transport = require("@modelcontextprotocol/sdk/inMemory.js") as {
    InMemoryTransport: { createLinkedPair(): [unknown, unknown] };
  };
  const server = require("@modelcontextprotocol/sdk/server/mcp.js") as {
    McpServer: new (info: { name: string; version: string }) => {
      connect(transport: unknown): Promise<void>;
      registerTool(name: string, config: object, cb: (args: never) => unknown): unknown;
    };
  };
  return {
    Client: client.Client,
    InMemoryTransport: transport.InMemoryTransport,
    McpServer: server.McpServer,
  };
}

function heartServerPackageJson(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, "packages", "heart-server", "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("heart-server package.json was not found; the MCP SDK cannot be loaded");
}

async function callMcpInstance(
  instance: { connect?: (transport: unknown) => Promise<void> } | undefined,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!instance?.connect) throw new Error("mcp server boof is not configured");
  const { Client, InMemoryTransport } = loadMcpSdk();
  const client = new Client({ name: "fake-agent-sdk", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name: tool, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Small deterministic SDK double. It contains no transport and never opens a socket. */
export function fakeSdk(script: FakeStep[]): {
  sdk: AgentSdk;
  calls: {
    options: Record<string, any>[];
    prompts: unknown[];
    interrupts: number;
    setModel: (string | undefined)[];
    closed: number;
    mcpResults: McpCallRecord[];
  };
} {
  const calls = {
    options: [] as Record<string, any>[],
    prompts: [] as unknown[],
    interrupts: 0,
    setModel: [] as (string | undefined)[],
    closed: 0,
    mcpResults: [] as McpCallRecord[],
  };
  const query = (params: { prompt: unknown; options?: Record<string, any> }) => {
    const options = params.options ?? {};
    calls.options.push(options);
    calls.prompts.push(params.prompt);
    let ended = false;
    let interrupted = false;
    let wake: (() => void) | undefined;
    const q = {
      async *[Symbol.asyncIterator]() {
        let initialUuid: string | undefined;
        const prompt = params.prompt as
          string | { [Symbol.asyncIterator]?: () => AsyncIterator<{ uuid?: string }> };
        if (
          prompt &&
          typeof prompt !== "string" &&
          typeof prompt[Symbol.asyncIterator] === "function"
        ) {
          const first = await prompt[Symbol.asyncIterator]!().next();
          initialUuid = first.value?.uuid;
        }
        if (
          !script.some(
            (step) =>
              typeof step === "object" &&
              "emit" in step &&
              (step.emit as { type?: string; subtype?: string })?.type === "system" &&
              (step.emit as { subtype?: string })?.subtype === "init",
          )
        )
          yield { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" };
        for (const step of script) {
          if (ended) break;
          if (step === "hang")
            while (!ended && !interrupted) await new Promise<void>((resolve) => (wake = resolve));
          if (typeof step === "object" && "callMcp" in step) {
            const tool = step.callMcp;
            const args = step.args ?? {};
            const id = `toolu_${calls.mcpResults.length + 1}`;
            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id, name: `mcp__boof__${tool}`, input: args }],
              },
            };
            if (ended) break;
            let result: unknown;
            try {
              result = await callMcpInstance(options.mcpServers?.boof?.instance, tool, args);
            } catch (error) {
              result = {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: error instanceof Error ? error.message : String(error),
                  },
                ],
              };
            }
            calls.mcpResults.push({ tool, args, result });
            const isError = Boolean(
              result &&
              typeof result === "object" &&
              "isError" in result &&
              (result as { isError?: boolean }).isError,
            );
            yield {
              type: "user",
              message: {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: id, is_error: isError, content: result },
                ],
              },
            };
          }
          if (typeof step === "object" && "emit" in step) {
            const emitted = step.emit as { type?: string };
            yield emitted?.type === "result" &&
            initialUuid &&
            !("user_message_uuid" in (emitted as object)) &&
            !("user_message_uuids" in (emitted as object))
              ? { ...emitted, user_message_uuid: initialUuid }
              : emitted;
          }
        }
      },
      async interrupt() {
        calls.interrupts++;
        const configured = script.find(
          (step) => typeof step === "object" && "interruptResult" in step,
        );
        if (configured && typeof configured === "object" && "interruptResult" in configured) {
          if (configured.interruptResult instanceof Error) throw configured.interruptResult;
          interrupted = true;
          wake?.();
          return configured.interruptResult;
        }
        interrupted = true;
        wake?.();
        return undefined;
      },
      async setModel(model?: string) {
        calls.setModel.push(model);
      },
      async close() {
        ended = true;
        calls.closed++;
        wake?.();
      },
    };
    return q;
  };
  return { sdk: { query } as unknown as AgentSdk, calls };
}
