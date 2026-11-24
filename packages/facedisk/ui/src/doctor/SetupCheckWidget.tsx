import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { buttonVariants } from "../ui/button.js";
import type { HarnessesState } from "../useHarnesses.js";
import { doctorView, needsAttention, type DoctorChip } from "../lib/doctor.js";
import { formatRoute } from "../lib/route.js";
import { cn } from "../lib/utils.js";
import { CheckRows } from "./CheckRows.js";

const ICON: Record<"ok" | "warn" | "fail" | "loading", LucideIcon> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  loading: Loader2,
};

/** A compact icon button: 32px, 44px on small or touch screens; the name is its label and tooltip. */
const ICON_BTN =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[color:var(--dc-sub)] transition-colors hover:bg-black/5 hover:text-[color:var(--dc-fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current disabled:opacity-50 dark:hover:bg-white/10 max-[719px]:size-11 pointer-coarse:size-11";

function Chip({ chip }: { chip: DoctorChip }) {
  const cls =
    "dc-chip inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[length:var(--text-meta)] leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current";
  const body = (
    <>
      <span aria-hidden className="dc-chip-dot size-1.5 shrink-0 rounded-full" />
      <span className="min-w-0 truncate">{chip.label}</span>
      {chip.tone === "ok" && <span className="sr-only">: passed</span>}
      {chip.tone !== "ok" && chip.tone !== "optional" && (
        <span className="sr-only">: {chip.reason}</span>
      )}
    </>
  );
  return chip.route ? (
    <a
      href={formatRoute(chip.route)}
      className={cls}
      data-tone={chip.tone}
      data-testid={`chip-${chip.key}`}
      title={`${chip.reason} Click to fix.`}
    >
      {body}
    </a>
  ) : (
    <span
      className={cls}
      data-tone={chip.tone}
      data-testid={`chip-${chip.key}`}
      title={chip.reason}
    >
      {body}
    </span>
  );
}

/**
 * The Doctor card on the first page: always shown, never blocking. Calm when everything passes (one
 * line and chips); it grows, tints and offers a fix when something needs attention. It reads the
 * shared harness state, so it adds no request of its own.
 */
export function SetupCheckWidget({
  harnesses,
  pid,
}: {
  harnesses: HarnessesState;
  pid: string | null;
}) {
  const { status, loading, failed, denied, refresh } = harnesses;
  const [chosen, setChosen] = useState<boolean | null>(null);
  const attention = status ? needsAttention(status) : false;
  const open = chosen ?? attention;
  const view = status ? doctorView(status, pid) : null;
  const tone = view ? view.tone : denied ? "warn" : failed ? "fail" : "loading";
  const Icon = ICON[tone];
  const headline = view
    ? view.headline
    : denied
      ? "This key cannot read the Doctor"
      : failed
        ? "Could not run the checks"
        : "Checking…";
  const summary = view
    ? view.summary
    : denied
      ? "Ask for a key with settings:read to see the checks."
      : failed
        ? "Try again in a moment."
        : "Looking at agents, git and folders";
  const grown = tone === "warn" || tone === "fail";
  return (
    <section
      aria-label="Doctor"
      data-testid="setup-check"
      data-state={open ? "expanded" : "compact"}
      data-tone={tone}
      className={cn(
        "dc flex min-w-0 flex-col gap-3 rounded-xl border text-[length:var(--text-row)]",
        grown ? "p-4" : "px-3 py-2.5",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-[color:var(--dc-icon-bg)] text-[color:var(--dc-icon-fg)]",
            grown ? "size-10" : "size-8",
          )}
        >
          <Icon className={cn(grown ? "size-5" : "size-4", tone === "loading" && "animate-spin")} />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            data-testid="setup-check-summary"
            className="m-0 text-[length:var(--text-body)] font-normal"
          >
            {headline}
          </h2>
          <p className="m-0 text-[length:var(--text-meta)] text-[color:var(--dc-sub)]">{summary}</p>
        </div>
        <div className="-my-1 -mr-1 flex shrink-0 items-center">
          <button
            type="button"
            className={ICON_BTN}
            aria-label="Check again"
            title="Check again"
            disabled={loading}
            onClick={refresh}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
          </button>
          {status && (
            <button
              type="button"
              className={ICON_BTN}
              aria-label={open ? "Hide details" : "Show details"}
              title={open ? "Hide details" : "Show details"}
              aria-expanded={open}
              onClick={() => setChosen(!open)}
            >
              <ChevronDown
                className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
                aria-hidden
              />
            </button>
          )}
          <a
            href={formatRoute({ name: "doctor" })}
            className={ICON_BTN}
            aria-label="Open full check"
            title="Open full check"
          >
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </div>
      </div>
      {view && (
        <div className="flex flex-wrap items-center gap-2 pl-0 min-[720px]:pl-11">
          {view.chips.map((c) => (
            <Chip key={c.key} chip={c} />
          ))}
          {grown && view.fix && (
            <a
              href={formatRoute(view.fix)}
              className={cn(
                buttonVariants({ size: "sm" }),
                "ml-auto max-[719px]:h-11 max-[719px]:w-full",
              )}
            >
              Fix it
            </a>
          )}
        </div>
      )}
      {status && open && (
        <div className="animate-in fade-in slide-in-from-top-1 duration-200 min-[720px]:pl-11">
          <div className="rounded-lg bg-surface p-3 text-ink">
            <CheckRows status={status} pid={pid} />
          </div>
        </div>
      )}
    </section>
  );
}
