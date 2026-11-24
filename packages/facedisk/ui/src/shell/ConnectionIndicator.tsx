import { useEffect, useRef, useState } from "react";
import { tooltip, type Connection } from "../lib/connection.js";
import { useConnection } from "../lib/useConnection.js";

const WORD = {
  live: "",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  "signed-out": "Sign in needed",
} as const;

/** What a screen reader hears when the state changes (never on first paint). */
export function announcement(c: Connection): string {
  return c.state === "live" ? "Connected" : tooltip(c);
}

/**
 * A quiet dot in the topbar: filled while live, a pulsing ring while reconnecting, a crossed dot
 * when offline or signed out. Its words show only when something is wrong.
 */
export function ConnectionIndicator() {
  const c = useConnection();
  const first = useRef(c.state);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (c.state !== first.current) setSaid(announcement(c));
  }, [c.state, c.since]);
  const shape =
    c.state === "live"
      ? "bg-current opacity-50"
      : c.state === "reconnecting"
        ? "border-2 border-current animate-pulse"
        : "border-2 border-current bg-current/30";
  return (
    <span
      data-testid="connection"
      data-state={c.state}
      title={tooltip(c)}
      className="flex shrink-0 items-center gap-1.5 text-[length:var(--text-meta)]"
    >
      <span aria-hidden className={`size-2.5 rounded-full ${shape}`} />
      {c.state !== "live" && <span className="hidden min-[720px]:inline">{WORD[c.state]}</span>}
      <span role="status" aria-live="polite" className="sr-only">
        {said}
      </span>
    </span>
  );
}
