import type { ReactNode } from "react";
import type { Status } from "@boof-runner/shared/schema";
import { cn } from "@/lib/utils";
import { statusLabel, statusTone, type Tone } from "../lib/status.js";

const TONE_CLASS: Record<Tone, string> = {
  // The fill is always `surface`, so the text colour is measured against one known background
  // (a tint of the colour itself drops light-mode text below 4.5:1); the border carries the tone.
  neutral: "bg-surface text-ink-muted border-line",
  running: "bg-surface text-running border-running/40",
  attention: "bg-surface text-attention border-attention/40",
  done: "bg-surface text-done border-done/40",
  failed: "bg-surface text-failed border-failed/40",
};

/** A word in a pill; the tone colours it but the word carries the meaning. */
export function TonePill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
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
      {children}
    </span>
  );
}

/** A status as a word in a pill. */
export function StatusPill({ status, className }: { status: Status; className?: string }) {
  return (
    <TonePill tone={statusTone(status)} className={className}>
      {statusLabel(status)}
    </TonePill>
  );
}
