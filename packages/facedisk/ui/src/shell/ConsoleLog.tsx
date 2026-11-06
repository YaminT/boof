import type { PendingChangeView } from "../api-types.js";
import { changeRowView } from "../lib/assistant-console.js";
import type { ConsoleLine } from "../lib/console-session.js";

const STATE_TONE: Record<string, string> = {
  Applied: "text-ink",
  Discarded: "text-ink-muted",
  Expired: "text-ink-muted",
};

/**
 * The console's output rows. Every `text` is model or server supplied and is rendered as a React
 * text node: a `<script>` or a markdown link shows as the literal characters. The only anchors are
 * the app-relative `href` of a change the assistant made.
 */
export function ConsoleLog({
  lines,
  pending,
  now,
  onReview,
  onDiscard,
}: {
  lines: ConsoleLine[];
  pending: PendingChangeView[];
  now: number;
  onReview(change: PendingChangeView): void;
  onDiscard(id: string): void;
}) {
  return (
    <>
      {lines.map((l, i) => {
        if (l.kind === "pending") {
          const view = changeRowView(l, pending, now);
          return (
            <div
              key={i}
              data-kind="pending"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5"
            >
              <span className="min-w-0 break-words whitespace-pre-wrap text-ink">
                Proposed: {l.text}
              </span>
              {view.kind === "waiting" ? (
                <span className="flex gap-1">
                  <button
                    type="button"
                    disabled={!view.change}
                    onClick={() => view.change && onReview(view.change)}
                    className="h-6 rounded-md border border-line px-2 text-ink hover:bg-accent disabled:opacity-50"
                  >
                    Review…
                  </button>
                  <button
                    type="button"
                    onClick={() => l.changeId && onDiscard(l.changeId)}
                    className="h-6 rounded-md px-2 text-ink-muted hover:bg-accent hover:text-ink"
                  >
                    Discard
                  </button>
                </span>
              ) : (
                <span
                  data-testid="change-state"
                  className={
                    view.label.startsWith("Failed")
                      ? "text-failed"
                      : (STATE_TONE[view.label] ?? "text-ink-muted")
                  }
                >
                  {view.label}
                </span>
              )}
            </div>
          );
        }
        const tone =
          l.kind === "assistant"
            ? "text-ink"
            : l.kind === "input"
              ? "text-ink-muted"
              : l.kind === "system"
                ? "text-attention"
                : "";
        return (
          <p key={i} data-kind={l.kind} className={`break-words whitespace-pre-wrap ${tone}`}>
            {l.kind === "change" && l.href ? <a href={l.href}>{l.text}</a> : l.text}
          </p>
        );
      })}
    </>
  );
}
