import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A native select styled like the kit's input. `mt-0`, `block` and `py-0` undo the legacy
 * `select` rule in styles.css (margin, padding), which otherwise clips the text.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "mt-0 block h-8 rounded-lg border border-input bg-surface px-2 py-0 text-[length:var(--text-row)] font-normal text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
