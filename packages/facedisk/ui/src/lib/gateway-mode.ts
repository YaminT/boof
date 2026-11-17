import type { Settings } from "@boof/heart/schema";

export type PoolMode = "internal" | "better-ccflare" | "none";
export type PoolStrategy = "ordered" | "round-robin";
export type PoolGateSetting = "pause" | "warn" | "off";

/** Shown on the Accounts page in internal mode (the plan's terms rule). */
export const TERMS_NOTE =
  "boof's built-in account pool takes Anthropic API keys only. Anthropic does not allow third-party tools to store or route Claude subscription sign-ins; Claude Code keeps using your own sign-in.";

export const MODE_LABELS: Record<PoolMode, string> = {
  internal: "Internal",
  "better-ccflare": "better-ccflare",
  none: "None",
};

/** Same rule as the server: `gateway.mode`, else better-ccflare when `owlish` is set, else none. */
export function poolModeOf(settings: Pick<Settings, "gateway" | "owlish">): PoolMode {
  if (settings.gateway) return settings.gateway.mode;
  return settings.owlish ? "better-ccflare" : "none";
}

/** The `gateway` value to save for a mode switch; strategy and health gate carry over. */
export function modeSettings(
  settings: Pick<Settings, "gateway">,
  mode: PoolMode,
): NonNullable<Settings["gateway"]> {
  const { strategy, healthGate } = settings.gateway ?? {};
  return { mode, ...(strategy ? { strategy } : {}), ...(healthGate ? { healthGate } : {}) };
}

/** Why an add-account form cannot be sent yet, or null. The key itself is never echoed. */
export function addAccountProblem(name: string, apiKey: string, priority: string): string | null {
  if (!name.trim()) return "Give the account a name.";
  if (name.trim().length > 80) return "Use a name of at most 80 characters.";
  const key = apiKey.trim();
  if (!key.startsWith("sk-ant-api") || key.length < 20)
    return "Enter an Anthropic Console API key (it starts with sk-ant-api). Subscription sign-ins are not accepted.";
  if (priority.trim() !== "") {
    const n = Number(priority);
    if (!Number.isInteger(n) || n < 0 || n > 100) return "Enter a whole priority from 0 to 100.";
  }
  return null;
}
