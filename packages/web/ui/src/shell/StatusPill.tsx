import type { Status } from "@boof-runner/shared/schema";
import { cn } from "@/lib/utils";
import { statusLabel, statusTone, type Tone } from "../lib/status.js";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-page text-ink-muted border-line",
  running: "bg-running/10 text-running border-running/30",
  attention: "bg-attention/10 text-attention border-attention/30",
  done: "bg-done/10 text-done border-done/30",
  failed: "bg-failed/10 text-failed border-failed/30",
};

/** A status as a word in a pill; the tone colours it but the word carries the meaning. */
export function StatusPill({ status, className }: { status: Status; className?: string }) {
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[length:var(--text-meta)] leading-4 font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {tone === "running" && (
        <span className="size-1.5 rounded-full bg-running motion-safe:animate-pulse" />
      )}
      {statusLabel(status)}
    </span>
  );
}
