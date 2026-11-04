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
  if (/[\r\n"'\\]/.test(value)) throw new Error("Invalid gateway URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid gateway URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Invalid gateway URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Invalid gateway URL");
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback)
    throw new Error("Gateway URL must use HTTPS off loopback");
  return value.replace(/\/+$/, "");
}

export function gatewayEnv(kind: GatewayKind, gateway: Gateway | undefined): NodeJS.ProcessEnv {
  if (!gateway) return {};
  const url = gatewayUrl(gateway.url);
  const key = gateway.apiKey || undefined;
  switch (kind) {
    case "anthropic":
      return { ANTHROPIC_BASE_URL: url, ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}) };
    case "openai":
      return { OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_KEY: key ?? DUMMY_OPENAI_KEY };
    case "opencode":
      return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            anthropic: { options: { baseURL: `${url}/v1`, ...(key ? { apiKey: key } : {}) } },
          },
        }),
      };
  }
}
