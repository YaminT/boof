import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useLive } from "../useLive.js";
import { currentStep } from "./log-tail.js";
import { startPoller, type Poller } from "./poller.js";

/**
 * The step of one running task: read when the log changes (live hints), and otherwise every
 * 90 s (10 s while the stream is down). Null until known or when no task is given.
 */
export function useRunningStep(pid: string | null, id: string | null): string | null {
  const [step, setStep] = useState<string | null>(null);
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
    setStep(null);
    if (!pid || !id) return;
    let alive = true;
    const p = startPoller({
      load: () =>
        api.liveLog(pid, id).then((r) => {
          if (alive) setStep(currentStep(r.log));
        }),
      live: () => liveUp.current,
      liveMs: 90_000,
      minGapMs: 5_000,
    });
    poller.current = p;
    return () => {
      alive = false;
      p.stop();
      poller.current = null;
    };
  }, [pid, id]);
  return step;
}
