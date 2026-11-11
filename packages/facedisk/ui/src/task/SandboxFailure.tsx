import { sandboxSettingsHref, sandboxUnavailableReason } from "../lib/sandbox-ui.js";

/**
 * A failed task whose log says `sandbox_unavailable`. A later success can leave the line in the
 * log, so a task that is not failed shows nothing.
 */
export function SandboxFailure({ pid, status, log }: { pid: string; status: string; log: string }) {
  if (status !== "failed") return null;
  const reason = sandboxUnavailableReason(log);
  if (!reason) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-attention/40 bg-surface px-3 py-2 text-[length:var(--text-row)] text-ink"
    >
      This task did not start because the sandbox is not available: {reason}.{" "}
      <a href={sandboxSettingsHref(pid)} className="font-medium underline">
        Open the sandbox setting
      </a>
    </div>
  );
}
