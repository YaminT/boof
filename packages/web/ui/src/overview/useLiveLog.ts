import { useEffect, useState } from "react";
import { api } from "../api.js";

const POLL_MS = 1200;

/** Polls the live log of a task every 1.2 s while `enabled`; `failed` is set while a request fails. */
export function useLiveLog(pid: string, id: string, enabled: boolean) {
  const [log, setLog] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () => {
      api
        .liveLog(pid, id)
        .then((r) => {
          if (!alive) return;
          setLog(r.log);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pid, id, enabled]);

  return { log, failed };
}
