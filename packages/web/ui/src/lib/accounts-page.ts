import type { Scope } from "@boof-runner/shared/schema";
import type { PoolState, Thresholds } from "../api-types.js";

export function accountActionAccess(held: ReadonlySet<Scope> | "all"): boolean {
  return held === "all" || held.has("settings:write");
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
