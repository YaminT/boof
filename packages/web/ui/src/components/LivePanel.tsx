import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Task } from "@boof-runner/shared/task-types";
import { currentStep, steeredCount } from "../lib/log-tail.js";

/**
 * Live output of the running task, shown on the Tasks page. Polls the live-log
 * endpoint on a short interval (codex streams chunk-by-chunk; the claude CLI
 * buffers --print output so its blocks land per step). Auto-scrolls while the
 * view is pinned to the bottom.
 */
export function LivePanel({
  projectId,
  task,
  onChange,
}: {
  projectId: string;
  task: Task;
  onChange: () => void;
}) {
  const [log, setLog] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"inject" | "stop" | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [mode, setMode] = useState<"next-step" | "now">("next-step");
  // Set by an "apply now" inject: how many `### Steered` blocks the log had at that moment.
  const [steerBaseline, setSteerBaseline] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);
  const id = task.frontmatter.id;

  useEffect(() => {
    let alive = true;
    const tick = () => {
      void api
        .liveLog(projectId, id)
        .then((r) => {
          if (alive) setLog(r.log);
        })
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId, id]);

  // Auto-scroll to newest output unless the user scrolled up to read history.
  useEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const inject = async () => {
    const text = prompt.trim();
    if (!text) return;
    setError(null);
    setBusy("inject");
    try {
      await api.injectPrompt(projectId, id, text, mode);
      if (mode === "now") setSteerBaseline(steeredCount(log));
      setPrompt("");
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setError(null);
    setBusy("stop");
    try {
      await api.stopTask(projectId, id);
      setStopRequested(true);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const step = currentStep(log);
  const steering = steerBaseline !== null && steeredCount(log) <= steerBaseline;
  return (
    <section className="live-panel">
      <div className="live-head">
        <span className="live-dot" title="Streaming live" />
        <strong>Working on “{task.frontmatter.title}”</strong>
        {step && <span className="live-step">{step}</span>}
        <button
          className="live-stop"
          onClick={stop}
          disabled={busy !== null || stopRequested}
          title="Stop the agent; the task moves to Stopped and keeps its worktree"
        >
          {busy === "stop" || stopRequested ? "Stopping…" : "Stop"}
        </button>
      </div>
      <pre className="live-body" ref={preRef} onScroll={onScroll}>
        {log || "Starting…"}
      </pre>
      <div className="live-inject">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Inject prompt while this task is running"
        />
        <button className="primary" onClick={inject} disabled={busy !== null || !prompt.trim()}>
          {busy === "inject" ? "Injecting…" : "Inject prompt"}
        </button>
        <fieldset className="live-mode">
          <legend className="sr-only">When to apply the prompt</legend>
          <label>
            <input
              type="radio"
              name={`inject-mode-${id}`}
              checked={mode === "next-step"}
              onChange={() => setMode("next-step")}
            />
            Apply at next step
          </label>
          <label title="Stops the agent's current step and continues it with the prompt; costs extra tokens">
            <input
              type="radio"
              name={`inject-mode-${id}`}
              checked={mode === "now"}
              onChange={() => setMode("now")}
            />
            Apply now (interrupts the current step)
          </label>
        </fieldset>
      </div>
      {steering && <p className="live-steering">Steering… interrupting the current step</p>}
      {error && <p className="error live-error">{error}</p>}
    </section>
  );
}
