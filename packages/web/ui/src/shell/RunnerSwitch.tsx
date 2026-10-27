import type { Settings } from "@boof-runner/shared/schema";
import { cn } from "@/lib/utils";
import { api } from "../api.js";
import { act } from "../lib/act.js";

/** Turns the runner on or off; the label says what the runner is doing now. */
export function RunnerSwitch({
  settings,
  onChange,
  onToggled,
}: {
  settings: Settings | null;
  onChange: () => Promise<void> | void;
  /** Called right after the click, e.g. to close a sheet. */
  onToggled?: () => void;
}) {
  const enabled = settings?.runner.enabled ?? false;
  const toggle = async () => {
    onToggled?.();
    await act(() => api.updateSettings({ runner: { enabled: !enabled } }), {
      failure: enabled ? "Could not pause the runner" : "Could not start the runner",
    });
    await onChange();
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={!settings}
      onClick={() => void toggle()}
      title={enabled ? "Pause the runner" : "Start the runner"}
      className="flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-[length:var(--text-row)] text-ink hover:bg-accent disabled:opacity-50"
    >
      <span className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", enabled ? "bg-done" : "bg-ink-muted/60")} />
        {enabled ? "Runner on" : "Runner paused"}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-4 w-7 rounded-full transition-colors",
          enabled ? "bg-accent-brand" : "bg-line",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3 rounded-full bg-surface transition-[left]",
            enabled ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}
