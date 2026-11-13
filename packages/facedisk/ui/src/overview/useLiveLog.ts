import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { startPoller, type Poller } from "../lib/poller.js";
import { useLive } from "../useLive.js";

/**
 * The live log of a task while `enabled`. It is read when the event stream says the project's
 * files changed (at most every 1.2 s), and otherwise every 15 s (3 s while the stream is down).
 * Polling pauses while the tab is hidden. `failed` is set while a request fails.
 */
export function useLiveLog(pid: string, id: string, enabled: boolean) {
  const [log, setLog] = useState("");
  const [failed, setFailed] = useState(false);
  const poller = useRef<Poller | null>(null);
  const liveUp = useRef(false);

  useLive({
    onEvent: (e) => {
      if (e.task === id) poller.current?.kick();
    },
    onChanged: (project) => {
      if (!project || project === pid) poller.current?.kick();
    },
    onStatus: (up) => {
      liveUp.current = up;
      poller.current?.replan();
    },
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const p = startPoller({
      load: () =>
        api.liveLog(pid, id).then(
          (r) => {
            if (!alive) return;
            setLog(r.log);
            setFailed(false);
          },
          (err) => {
            if (alive) setFailed(true);
            throw err;
          },
        ),
      live: () => liveUp.current,
      liveMs: 15_000,
      fallbackMs: 3_000,
      minGapMs: 1_200,
    });
    poller.current = p;
    return () => {
      alive = false;
      p.stop();
      poller.current = null;
    };
  }, [pid, id, enabled]);

  return { log, failed };
}
