import type { AgentSdk } from "./claude-agent-sdk.js";

export type FakeStep = "hang" | { emit: unknown } | { interruptResult: unknown };

/** Small deterministic SDK double. It contains no transport and never opens a socket. */
export function fakeSdk(script: FakeStep[]): {
  sdk: AgentSdk;
  calls: {
    options: Record<string, any>[];
    interrupts: number;
    setModel: (string | undefined)[];
    closed: number;
  };
} {
  const calls = {
    options: [] as Record<string, any>[],
    interrupts: 0,
    setModel: [] as (string | undefined)[],
    closed: 0,
  };
  const query = (params: { prompt: unknown; options?: Record<string, any> }) => {
    const options = params.options ?? {};
    calls.options.push(options);
    let ended = false;
    let interrupted = false;
    let wake: (() => void) | undefined;
    const q = {
      async *[Symbol.asyncIterator]() {
        const input = params.prompt as AsyncIterable<any>;
        const first = await input[Symbol.asyncIterator]().next();
        const initialUuid = first.value?.uuid;
        if (
          !script.some(
            (step) =>
              typeof step === "object" &&
              "emit" in step &&
              (step.emit as any)?.type === "system" &&
              (step.emit as any)?.subtype === "init",
          )
        )
          yield { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" };
        for (const step of script) {
          if (ended) break;
          if (step === "hang")
            while (!ended && !interrupted) await new Promise<void>((r) => (wake = r));
          if (typeof step === "object" && "emit" in step) {
            const emitted = step.emit as any;
            yield emitted?.type === "result" &&
            initialUuid &&
            !("user_message_uuid" in emitted) &&
            !("user_message_uuids" in emitted)
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
