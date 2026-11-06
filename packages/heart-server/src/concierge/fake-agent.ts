import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConciergeTurnError } from "@boof/heart";
import type {
  ConciergeAgent,
  ConciergeTurnInput,
  ConciergeTurnResult,
  TokenUsage,
} from "@boof/heart";

export type ScriptStep = { call: string; args: Record<string, unknown> } | { text: string };
export interface ScriptedAgentOptions {
  usage?: TokenUsage;
  cumulative?: TokenUsage;
  sessionId?: string | null;
  availability?: Awaited<ReturnType<ConciergeAgent["availability"]>>;
  fail?: {
    message: string;
    kind: "refused" | "timeout" | "aborted" | "failed";
    usage: TokenUsage | null;
    sessionId: string | null;
  };
}
export interface ScriptedAgent extends ConciergeAgent {
  inputs: ConciergeTurnInput[];
  results: unknown[];
}

/** Scripted in-process agent. Calls use the actual MCP instance supplied by ConciergeService. */
export function scriptedAgent(
  steps: ScriptStep[],
  options: ScriptedAgentOptions = {},
): ScriptedAgent {
  const usage = options.usage ?? { inputTokens: 10, outputTokens: 5, costUsd: 0.01, known: true };
  const cumulative = options.cumulative ?? usage;
  const agent: ScriptedAgent = {
    inputs: [],
    results: [],
    async availability() {
      return options.availability ?? { available: true, reason: null, via: "project-key" };
    },
    async turn(input) {
      agent.inputs.push(input);
      let text = "";
      const server = input.mcpServer as { connect(transport: unknown): Promise<void> };
      const client = new Client({ name: "scripted-concierge", version: "1.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        for (const step of steps) {
          if (input.signal?.aborted) {
            if (options.fail) throw turnError(options.fail);
            break;
          }
          if ("text" in step) {
            text += step.text;
            input.onEvent?.({ type: "text", text: step.text });
          } else {
            const result = await client.callTool({ name: step.call, arguments: step.args });
            agent.results.push(result);
          }
        }
      } finally {
        await client.close();
      }
      if (options.fail) throw turnError(options.fail);
      return {
        text,
        sessionId: options.sessionId ?? "session-1",
        usage,
        cumulative,
        stopReason: "done",
      } satisfies ConciergeTurnResult;
    },
  };
  return agent;
}

function turnError(error: NonNullable<ScriptedAgentOptions["fail"]>) {
  // Late import avoided: the helper's public shape remains a tiny fake agent.
  return new ConciergeTurnError(error.message, error.kind, error.usage, error.sessionId);
}
