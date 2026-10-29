import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/ui/button";
import { useLiveLog } from "../overview/useLiveLog.js";

const LINE_PX = 17;
const NEAR_BOTTOM_PX = 40;

/**
 * The log of a task as virtualised mono lines. It follows the tail while the user is at the bottom;
 * scrolling up pauses that until "Jump to latest". While `running` it polls the live log; otherwise
 * it shows `text` (the log from the task itself).
 */
export function LiveLog({
  pid,
  taskId,
  text,
  running,
}: {
  pid: string;
  taskId: string;
  text: string;
  running: boolean;
}) {
  const live = useLiveLog(pid, taskId, running);
  const log = running && live.log ? live.log : text;
  const lines = useMemo(() => (log === "" ? [] : log.replace(/\n+$/, "").split("\n")), [log]);

  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [paused, setPaused] = useState(false);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => LINE_PX,
    overscan: 20,
  });

  const toEnd = () => {
    if (lines.length > 0) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  };

  useEffect(() => {
    if (following.current) toEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom !== following.current) {
      following.current = atBottom;
      setPaused(!atBottom);
    }
  };

  if (lines.length === 0) {
    return (
      <p className="m-0 rounded-md border border-line bg-page px-3 py-2 text-[length:var(--text-row)] text-ink-muted">
        {running && live.failed ? "Live output unavailable. Retrying…" : "No output yet."}
      </p>
    );
  }

  return (
    <div className="relative">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label="Task log"
        tabIndex={0}
        className="h-[28rem] max-h-[60vh] overflow-auto rounded-md border border-line bg-page px-3 py-2 font-mono text-[length:var(--text-meta)] leading-[17px] text-ink"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full break-words whitespace-pre-wrap"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {lines[row.index] || " "}
            </div>
          ))}
        </div>
      </div>
      {paused && (
        <Button
          type="button"
          size="sm"
          className="absolute right-4 bottom-3 shadow-md"
          onClick={() => {
            following.current = true;
            setPaused(false);
            toEnd();
          }}
        >
          Jump to latest
        </Button>
      )}
      {running && live.failed && (
        <p className="mt-1 mb-0 text-[length:var(--text-meta)] text-ink-muted">
          Live output unavailable. Retrying…
        </p>
      )}
    </div>
  );
}
