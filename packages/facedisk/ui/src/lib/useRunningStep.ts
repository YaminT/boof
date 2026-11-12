import { useEffect, useState } from "react";
import { api } from "../api.js";
import { currentStep } from "./log-tail.js";

/** The step of one running task, polled gently; null until known or when no task is given. */
export function useRunningStep(pid: string | null, id: string | null): string | null {
  const [step, setStep] = useState<string | null>(null);
  useEffect(() => {
    setStep(null);
    if (!pid || !id) return;
    let alive = true;
    const tick = () =>
      api
        .liveLog(pid, id)
        .then((r) => alive && setStep(currentStep(r.log)))
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pid, id]);
  return step;
}
