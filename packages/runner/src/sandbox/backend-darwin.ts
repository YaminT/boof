import type { SandboxStatus } from "@boof/heart";

/**
 * macOS backend. I1g owns the real seatbelt rules. Until then enforce cannot start an agent,
 * and this stub never spawns one.
 */
export function darwinSandboxStatus(): SandboxStatus {
  return {
    mode: "enforce",
    backend: "darwin",
    state: "unavailable",
    reason: "macOS sandbox backend is not available until I1g",
  };
}
