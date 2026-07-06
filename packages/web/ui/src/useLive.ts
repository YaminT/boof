import { useEffect } from "react";

/**
 * Subscribe to the server's SSE stream and invoke `onChange` on each ping. SSE
 * is a hint: the callback re-fetches fresh data, and the browser auto-reconnects
 * EventSource, so a dropped connection self-heals (web-server / web-ui specs).
 */
export function useLive(onChange: () => void): void {
  useEffect(() => {
    const es = new EventSource("/api/events");
    const handler = () => onChange();
    es.addEventListener("changed", handler);
    es.onerror = () => {
      // EventSource reconnects automatically; refetch on recovery.
    };
    return () => {
      es.removeEventListener("changed", handler);
      es.close();
    };
  }, [onChange]);
}
