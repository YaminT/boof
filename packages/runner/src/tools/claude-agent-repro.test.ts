import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentTool } from "./claude-agent.js";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = {
  role: "developer" as const,
  model: "default",
  systemPrompt: "system",
  prompt: "hello",
  cwd: "/tmp",
  claudeConfigDir: "/tmp/boof-data/claude-agent-config/project",
  autoApprove: false,
  agentAuth: { kind: "gateway" as const, url: "http://127.0.0.1:0", apiKey: "fake-gateway-key" },
  env: {
    ANTHROPIC_API_KEY: "fake-gateway-key",
    CLAUDE_CONFIG_DIR: "/tmp/boof-data/claude-agent-config/project",
  },
};
const msg = (type: string, data: Record<string, unknown> = {}) => ({ type, ...data });
const delta = (text: string) =>
  msg("stream_event", {
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });

describe("review repro", () => {
  it.each([2, 3, 6, 11])(
    "R1: a key split into %i-character deltas never reaches onChunk",
    async (deltaSize) => {
      const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789";
      let promptStream!: AsyncIterable<any>;
      const query = {
        async *[Symbol.asyncIterator]() {
          const input = promptStream[Symbol.asyncIterator]();
          const first = await input.next();
          yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
          // The model echoes its key; the API streams it token by token.
          for (let i = 0; i < key.length; i += deltaSize) yield delta(key.slice(i, i + deltaSize));
          yield msg("result", {
            subtype: "success",
            result: "done",
            total_cost_usd: 0,
            modelUsage: {},
            user_message_uuids: [first.value.uuid],
          });
        },
        async interrupt() {},
        async setModel() {},
        async close() {},
      };
      const tool = new ClaudeAgentTool({
        loadSdk: async () =>
          ({
            query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
              promptStream = prompt;
              return query;
            },
          }) as any,
        resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      });
      const chunks: string[] = [];
      const dir = await mkdtemp(join(tmpdir(), "claude-agent-redaction-log-"));
      const logPath = join(dir, "log.txt");
      let writes = Promise.resolve();
      try {
        const result = await tool.run({
          ...base,
          agentAuth: { kind: "project-key", apiKey: key },
          onChunk: (c) => {
            chunks.push(c);
            writes = writes.then(() => appendFile(logPath, c));
          },
        });
        await writes;
        expect(result.output).not.toContain(key); // the final transcript is scrubbed
        expect(chunks.join("")).not.toContain(key);
        // pipeline.streamChunk appends onChunk to log.txt; tasks.liveLog reads this same file.
        expect(await readFile(logPath, "utf8")).not.toContain(key);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("R2: a result without system/init is refused", async () => {
    let promptStream!: AsyncIterable<any>;
    const tool = new ClaudeAgentTool({
      loadSdk: async () =>
        ({
          query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
            promptStream = prompt;
            return {
              async *[Symbol.asyncIterator]() {
                const first = await promptStream[Symbol.asyncIterator]().next();
                yield msg("result", {
                  subtype: "success",
                  result: "ok",
                  total_cost_usd: 0,
                  modelUsage: {},
                  user_message_uuids: [first.value.uuid],
                });
              },
              async close() {},
            };
          },
        }) as any,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    await expect(
      tool.run({
        ...base,
        agentAuth: { kind: "project-key", apiKey: "sk-ant-api03-abcdefghijklmnop" },
      }),
    ).rejects.toMatchObject({ output: expect.stringContaining("apiKeySource=unknown") });
  });

  it("R3: a steer that lands after the final result is taken but never delivered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-late-steer-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    let promptStream!: AsyncIterable<any>;
    // Like the SDK's streamInput: the prompt iterable is consumed eagerly and stdin closes at its end.
    const stdin: string[] = [];
    let stdinClosed = false;
    let firstUuid!: string;
    let gotFirst!: () => void;
    const first = new Promise<void>((r) => (gotFirst = r));
    const query = {
      async *[Symbol.asyncIterator]() {
        void (async () => {
          for await (const m of promptStream) {
            if (!firstUuid) {
              firstUuid = m.uuid;
              gotFirst();
            } else stdin.push(m.message.content);
          }
          stdinClosed = true;
        })();
        await first;
        yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
        yield msg("result", {
          subtype: "success",
          result: "final",
          total_cost_usd: 0.1,
          modelUsage: {},
          user_message_uuids: [firstUuid],
        });
        // The user steers just after the result; Claude Code takes a moment to exit.
        await writeFile(steerSignalPath, JSON.stringify({ text: "late steer" }) + "\n");
        await new Promise((r) => setTimeout(r, 100));
      },
      async interrupt() {},
      async setModel() {},
      async close() {},
    };
    const onSteer = vi.fn(async () => {
      await rm(steerSignalPath, { force: true });
      return { texts: ["late steer"], last: false };
    });
    const tool = new ClaudeAgentTool({
      loadSdk: async () =>
        ({
          query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
            promptStream = prompt;
            return query;
          },
        }) as any,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      const result = await tool.run({ ...base, steerSignalPath, onSteer });
      expect(result.report).toBe("final");
      expect(stdinClosed).toBe(true);
      expect(onSteer).not.toHaveBeenCalled();
      expect(stdin).toEqual([]);
      expect(
        await import("node:fs/promises")
          .then(({ access }) => access(steerSignalPath))
          .then(
            () => true,
            () => false,
          ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { recordSpend } from "@boof/heart";
describe("review repro budget", () => {
  it("R4: a resumed claude-agent attempt is recorded as $0 in the day ledger", async () => {
    const { usageFromSdkResult } = await import("./claude-agent.js");
    const u = usageFromSdkResult(
      {
        total_cost_usd: 1.0,
        modelUsage: { m: { inputTokens: 10, outputTokens: 10, costUSD: 1.0, costBasis: "list" } },
      },
      { inputTokens: 5, outputTokens: 5, costUsd: 0.4, known: true },
    );
    expect(u.costUsd).toBeCloseTo(0.6);
    expect(u.known).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "bfr-ledger-"));
    try {
      await recordSpend({
        projectId: "p",
        projectDir: dir,
        tool: "claude-agent",
        usage: u,
        timezone: "UTC",
      });
      const { readFile, readdir } = await import("node:fs/promises");
      const files = await readdir(join(dir), { recursive: true });
      const text = (
        await Promise.all(
          files
            .filter((f) => String(f).endsWith(".json"))
            .map((f) => readFile(join(dir, String(f)), "utf8")),
        )
      ).join("\n");
      expect(text).toMatch(/"costUsd": ?0\.6/);
      expect(text).toMatch(/"unknownSteps": ?0/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
