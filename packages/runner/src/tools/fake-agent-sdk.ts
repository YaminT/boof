import type { AgentSdk } from "./claude-agent-sdk.js";

export type FakeStep =
  "emit" | "waitForPush" | "hang" | { emit: unknown } | { interruptResult: unknown };

/** Small deterministic SDK double. It contains no transport and never opens a socket. */
export function fakeSdk(script: FakeStep[]): {
  sdk: AgentSdk;
  calls: {
    options: Record<string, any>[];
    pushed: any[];
    interrupts: number;
    setModel: (string | undefined)[];
    closed: number;
  };
} {
  const calls = {
    options: [] as Record<string, any>[],
    pushed: [] as any[],
    interrupts: 0,
    setModel: [] as (string | undefined)[],
    closed: 0,
  };
  const query = (params: { prompt: unknown; options?: Record<string, any> }) => {
    const options = params.options ?? {};
    calls.options.push(options);
    let ended = false;
    const pending: any[] = [];
    let wake: (() => void) | undefined;
    const q = {
      async *[Symbol.asyncIterator]() {
        for (const step of script) {
          if (ended) break;
          if (step === "hang") while (!ended) await new Promise<void>((r) => (wake = r));
          if (step === "waitForPush")
            while (!pending.length && !ended) await new Promise<void>((r) => (wake = r));
          if (typeof step === "object" && "emit" in step) yield step.emit;
          else if (step === "emit") yield undefined;
        }
        while (pending.length && !ended) {
          calls.pushed.push(pending.shift());
          await Promise.resolve();
        }
      },
      async interrupt() {
        calls.interrupts++;
        const configured = script.find(
          (step) => typeof step === "object" && "interruptResult" in step,
        );
        if (configured && typeof configured === "object" && "interruptResult" in configured) {
          if (configured.interruptResult instanceof Error) throw configured.interruptResult;
          return configured.interruptResult;
        }
        return undefined;
      },
      async setModel(model?: string) {
        calls.setModel.push(model);
      },
      async streamInput(stream: AsyncIterable<unknown>) {
        for await (const item of stream) {
          pending.push(item);
          wake?.();
        }
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
