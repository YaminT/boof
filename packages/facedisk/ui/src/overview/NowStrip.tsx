import { currentStep } from "../lib/log-tail.js";
import { formatRoute } from "../lib/route.js";
import type { TaskGroups } from "../lib/task-groups.js";
import { useEffect, useState } from "react";
import { api } from "../api.js";

/** The step of the single running task, polled gently; null until known. */
function useStep(pid: string, id: string | null): string | null {
  const [step, setStep] = useState<string | null>(null);
  useEffect(() => {
    setStep(null);
    if (!id) return;
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

/** One line above Tasks and Plans: what runs and how many things need the user. */
export function NowStrip({ pid, groups }: { pid: string; groups: TaskGroups }) {
  const running = groups.running;
  const single = running.length === 1 ? running[0] : null;
  const step = useStep(pid, single ? single.frontmatter.id : null);
  const needs = groups.needsYou.length;
  if (running.length === 0 && needs === 0) return null;
  const href = formatRoute({ name: "overview", pid });
  return (
    <p className="mt-0 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--text-row)]">
      {running.length > 0 && (
        <a href={href} className="text-ink no-underline hover:underline">
          {single
            ? `Running: ${single.frontmatter.title}${step ? ` (${step})` : ""}`
            : `Running: ${running.length} tasks`}
        </a>
      )}
      {needs > 0 && (
        <a href={href} className="font-medium text-attention no-underline hover:underline">
          Needs you: {needs}
        </a>
      )}
    </p>
  );
}
