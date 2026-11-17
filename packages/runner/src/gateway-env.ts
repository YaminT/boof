import { parseOwlishGatewayUrl } from "@boof/heart/schema";

/**
 * The environment that routes a task agent through the account pool (better-ccflare). Built from
 * the configured gateway and added on top of `agentEnv()`'s allowlist by the tool adapters, so
 * the explicit gateway wins over a variable inherited from the server. Everything goes by
 * environment: the client key is never an argument (it would show in `ps`) and never written to a
 * tool's config file. Provider logins and credentials are left alone.
 */

/** Where a routed tool's requests go: the gateway URL and boof's one client key, if it has one. */
export interface Gateway {
  url: string;
  /** The ccflare client key; absent when the gateway needs none. Never logged. */
  apiKey?: string;
}

/** Which API family a tool speaks: Anthropic (claude), OpenAI (codex) or opencode's own config. */
export type GatewayKind = "anthropic" | "openai" | "opencode";

/** The placeholder Codex needs when the gateway has no key: it refuses to start without one. */
export const DUMMY_OPENAI_KEY = "dummy-key";

/** Validate and normalize a gateway URL before putting it in an environment or Codex TOML. */
export function gatewayUrl(value: string): string {
  const parsed = parseOwlishGatewayUrl(value);
  if (!parsed) throw new Error("Invalid gateway URL");
  return parsed.href.replace(/\/+$/, "");
}

/** `base`'s NO_PROXY with a loopback gateway host added, so the run token never goes to a proxy. */
function noProxy(url: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return {};
  const merge = (current: string | undefined) =>
    current?.split(",").some((h) => h.trim() === host)
      ? current
      : [current?.trim(), host].filter(Boolean).join(",");
  const value = merge(base.NO_PROXY ?? base.no_proxy);
  return { NO_PROXY: value, no_proxy: value };
}

export function gatewayEnv(
  kind: GatewayKind,
  gateway: Gateway | undefined,
  base: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  if (!gateway) return {};
  const url = gatewayUrl(gateway.url);
  const key = gateway.apiKey || undefined;
  switch (kind) {
    case "anthropic":
      return {
        ANTHROPIC_BASE_URL: url,
        ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}),
        ...noProxy(url, base),
      };
    case "openai":
      return { OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_KEY: key ?? DUMMY_OPENAI_KEY };
    case "opencode":
      return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            anthropic: { options: { baseURL: `${url}/v1`, ...(key ? { apiKey: key } : {}) } },
          },
        }),
        ...noProxy(url, base),
      };
  }
}

/** Whether a tool is handed the pool gateway in this gateway mode (codex is not, in internal mode). */
export function toolUsesPool(
  tool: { acceptsPool?: boolean; acceptsInternalPool?: boolean } | undefined,
  mode: string,
): boolean {
  if (!tool?.acceptsPool) return false;
  return !(mode === "internal" && tool.acceptsInternalPool === false);
}
