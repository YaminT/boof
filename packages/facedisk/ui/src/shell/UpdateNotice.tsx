import { useEffect, useRef, useState } from "react";
import { dismissUpdateNotice, getUpdateNotice, type UpdateNotice as Notice } from "../api.js";

/** The one line the shell shows for a newer release. `null` renders nothing. */
export function UpdateNoticeView({
  notice,
  onDismiss,
}: {
  notice: Notice | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-attention/40 bg-surface px-3 py-2 text-[length:var(--text-row)]"
    >
      <span>
        New version available:{" "}
        <a
          href={notice.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline"
        >
          {notice.version}
        </a>
      </span>
      <button type="button" className="text-ink-muted underline" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * Loads the cached notice, and again a few seconds later: the check runs after the server is up
 * and may finish after the first paint. Dismissal hides this version until a newer one is cached.
 */
export function UpdateNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const hidden = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      void getUpdateNotice()
        .then((next) => {
          if (!live) return;
          if (next && hidden.current === next.version) return;
          setNotice(next);
        })
        .catch(() => {});
    };
    load();
    const soon = setTimeout(load, 3_000);
    const later = setTimeout(load, 15_000);
    return () => {
      live = false;
      clearTimeout(soon);
      clearTimeout(later);
    };
  }, []);
  return (
    <UpdateNoticeView
      notice={notice}
      onDismiss={() => {
        if (!notice) return;
        const current = notice;
        hidden.current = current.version;
        setNotice(null);
        void dismissUpdateNotice(current.version).catch(() => {
          if (hidden.current === current.version) hidden.current = null;
          setNotice(current);
        });
      }}
    />
  );
}
