import type { AccountSummary } from "./owlish.js";

export const AGENT_SDK_API_KEY_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-console-api",
  "bedrock",
  "vertex-ai",
  "zai",
  "minimax",
  "deepseek",
  "anthropic-compatible",
  "openai-compatible",
  "nanogpt",
  "kilo",
  "openrouter",
  "alibaba-coding-plan",
  "ollama",
  "ollama-cloud",
  "meta",
]);

export interface AgentSdkBlockingAccount {
  id: string;
  name: string;
  provider: string | null;
  why: "subscription" | "oauth-token" | "unknown-type";
}
export interface AgentSdkEligibility {
  gateway: "absent" | "checked";
  allowed: boolean;
  /** One sentence; at most 300 characters; never contains a key. */
  reason: string;
  blocking: AgentSdkBlockingAccount[];
  checkedAt: string;
}

const SUBSCRIPTION = new Set(["anthropic", "codex", "codebuddy", "qwen", "xai"]);
const MAX_REASON = 300;
const bounded = (text: string) =>
  text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`;
const safeName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80);

export function agentSdkEligibility(
  accounts: AccountSummary[] | null,
  now: Date,
  detail?: string,
): AgentSdkEligibility {
  let blocking: AgentSdkBlockingAccount[] = [];
  let reason: string;
  if (accounts === null) {
    reason = `the account types of the better-ccflare gateway could not be determined (${detail ?? "malformed answer"})`;
  } else if (accounts.length === 0) {
    reason = "the better-ccflare gateway has no accounts";
  } else {
    blocking = accounts.flatMap((account) => {
      const provider =
        typeof account.provider === "string" && account.provider.length > 0
          ? account.provider
          : null;
      const why =
        provider === null ||
        (!SUBSCRIPTION.has(provider) && !AGENT_SDK_API_KEY_PROVIDERS.has(provider))
          ? "unknown-type"
          : SUBSCRIPTION.has(provider)
            ? "subscription"
            : account.hasRefreshToken === true
              ? "oauth-token"
              : null;
      return why
        ? [{ id: account.id.slice(0, 200), name: safeName(account.name), provider, why }]
        : [];
    });
    if (blocking.length === 0) reason = "every better-ccflare account uses API-key authentication";
    else {
      const groups = [
        ["subscription", "subscription accounts"],
        ["oauth-token", "OAuth-token accounts"],
        ["unknown-type", "accounts with unknown authentication types"],
      ] as const;
      const details = groups.flatMap(([why, label]) => {
        const matches = blocking.filter((item) => item.why === why);
        if (!matches.length) return [];
        return blocking.length > 20
          ? [`${matches.length} ${label}`]
          : [`${label} (${matches.map((item) => item.name).join(", ")})`];
      });
      reason = `the better-ccflare gateway would route to ${details.join("; ")}`;
    }
    blocking = blocking.slice(0, 20);
  }
  return {
    gateway: "checked",
    allowed: accounts !== null && accounts.length > 0 && blocking.length === 0,
    reason: bounded(reason),
    blocking,
    checkedAt: now.toISOString(),
  };
}

export type AgentAuth =
  { kind: "gateway"; url: string; apiKey?: string } | { kind: "project-key"; apiKey: string };
export type AgentAuthDecision =
  { ok: true; via: "gateway" | "project-key"; note: string | null } | { ok: false; reason: string };
export const AGENT_AUTH_POLICY =
  "Anthropic allows the Agent SDK only with API-key authentication; subscription (OAuth) accounts stay on the claude-code CLI.";

export function decideAgentAuth(input: {
  projectName: string;
  choice: "gateway" | "project-key";
  gatewayConfigured: boolean;
  eligibility: AgentSdkEligibility | null;
  hasProjectKey: boolean;
}): AgentAuthDecision {
  const refuse = (why: string): AgentAuthDecision => ({
    ok: false,
    reason: `claude-agent cannot start: ${why}. ${AGENT_AUTH_POLICY} Set an Anthropic API key for project "${input.projectName}" (Settings › Project), or use claude-code for this role.`,
  });
  if (input.choice === "project-key")
    return input.hasProjectKey
      ? { ok: true, via: "project-key", note: null }
      : refuse("the project uses its own API key, but none is set");
  const why = !input.gatewayConfigured
    ? "no better-ccflare gateway is configured"
    : (input.eligibility?.reason ??
      "the account types of the better-ccflare gateway could not be determined (malformed answer)");
  if (input.gatewayConfigured && input.eligibility?.allowed)
    return { ok: true, via: "gateway", note: null };
  if (input.hasProjectKey)
    return {
      ok: true,
      via: "project-key",
      note: `better-ccflare gateway not used: ${why}; using the project's API key`,
    };
  return refuse(why);
}
