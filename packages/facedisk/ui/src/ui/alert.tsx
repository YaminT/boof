import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A readable inline message with a filled surface for reliable theme contrast. */
export function Alert({
  tone = "failed",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: "failed" | "attention"; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border bg-surface p-3 text-sm",
        tone === "failed" ? "border-failed/40 text-failed" : "border-attention/40 text-attention",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
