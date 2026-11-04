import type { Scope } from "@boof/heart/schema";
import type { PoolState, Thresholds } from "../api-types.js";

export function accountActionAccess(
  held: ReadonlySet<Scope> | "all",
  trust: "trusted" | "review" = "trusted",
  projects: "*" | string[] = "*",
): boolean {
  return (held === "all" || held.has("settings:write")) && trust === "trusted" && projects === "*";
}

export function gatePauses(gate: "pause" | "warn" | "off" | null, status: PoolState): boolean {
  return gate === "pause" && ["degraded", "unhealthy", "unreachable"].includes(status);
}

export function thresholdFields(thresholds: Thresholds): [string, string][] {
  return Object.entries(thresholds).map(([name, value]) => [
    name,
    value === null ? "" : String(value),
  ]);
}

export function priorityProblem(value: string): string | null {
  if (!value.trim() || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 100)
    return "Enter a whole priority from 0 to 100.";
  return null;
}
