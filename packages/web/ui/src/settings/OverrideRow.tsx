import type { ReactNode } from "react";
import { NativeSelect } from "@/ui/native-select";

/**
 * One setting with a project column: the value for all projects, and for this project either
 * "same as all projects" or its own value. Under 720 px the three cells stack.
 */
export function OverrideRow({
  label,
  inherit,
  onInherit,
  inheritedText,
  global,
  override,
}: {
  label: string;
  /** True while this project follows the all-projects value. */
  inherit: boolean;
  onInherit: (inherit: boolean) => void;
  /** The all-projects value, shown in the inherit choice: "Same as all projects (2)". */
  inheritedText: string;
  global: ReactNode;
  /** The control for this project's own value, shown when not inheriting. */
  override: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-b border-line py-3 last:border-b-0 min-[720px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] min-[720px]:items-start min-[720px]:gap-4">
      <div className="text-[length:var(--text-body)] font-medium">{label}</div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[length:var(--text-meta)] text-ink-muted min-[720px]:hidden">
          All projects
        </span>
        {global}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[length:var(--text-meta)] text-ink-muted min-[720px]:hidden">
          This project
        </span>
        <NativeSelect
          aria-label={`${label}: this project`}
          className="w-full"
          value={inherit ? "inherit" : "override"}
          onChange={(e) => onInherit(e.target.value === "inherit")}
        >
          <option value="inherit">
            Same as all projects{inheritedText ? ` (${inheritedText})` : ""}
          </option>
          <option value="override">Override</option>
        </NativeSelect>
        {!inherit && override}
      </div>
    </div>
  );
}
