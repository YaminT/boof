import type { TokenUsage } from "@boof-runner/shared";

export const UNKNOWN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  known: false,
};

/**
 * Best-effort token/cost extraction from tool output. Tools print usage in
 * varying formats; we scan for common patterns and fall back to "unknown"
 * (token-tracking spec: missing data must never fail the pipeline).
 */
export function parseUsage(output: string): TokenUsage {
  let input = 0;
  let outputTok = 0;
  let cost = 0;
  let known = false;

  // JSON-ish: "input_tokens": 123 / "output_tokens": 456
  const inMatch = output.match(
    /(?<![A-Za-z_])["']?(?:input_tokens|inputTokens|prompt_tokens)["']?\s*[:=]\s*(\d+)/i,
  );
  const outMatch = output.match(
    /(?<![A-Za-z_])["']?(?:output_tokens|outputTokens|completion_tokens)["']?\s*[:=]\s*(\d+)/i,
  );
  const costMatch = output.match(/(?:cost|total cost)\D*\$?\s*([0-9]+\.?[0-9]*)/i);

  if (inMatch) {
    input = Number(inMatch[1]);
    known = true;
  }
  if (outMatch) {
    outputTok = Number(outMatch[1]);
    known = true;
  }
  if (costMatch) {
    cost = Number(costMatch[1]);
    known = true;
  }

  return { inputTokens: input, outputTokens: outputTok, costUsd: cost, known };
}

/** Sum a list of usages into a single aggregate. */
export function sumUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      costUsd: acc.costUsd + u.costUsd,
      known: acc.known || u.known,
    }),
    { ...UNKNOWN_USAGE },
  );
}
