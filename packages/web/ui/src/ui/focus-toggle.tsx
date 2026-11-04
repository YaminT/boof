import { Button } from "@/ui/button";
import type { FocusMode } from "../lib/focus-mode.js";

/**
 * Switches a screen between the simple and the expanded view. The text says the current view; the
 * accessible name stays constant, and `aria-pressed` is true while expanded.
 */
export function FocusToggle({
  mode,
  onToggle,
  className,
}: {
  mode: FocusMode;
  onToggle: () => void;
  className?: string;
}) {
  const expanded = mode === "expanded";
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={expanded}
      aria-label="Expanded view"
      title={expanded ? "Show simple view" : "Show expanded view"}
      onClick={onToggle}
      className={className}
    >
      Expanded view
    </Button>
  );
}
