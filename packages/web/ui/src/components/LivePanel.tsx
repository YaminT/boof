import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Task } from "../types.js";

/** Pull the most recent "### Step" header out of the log as the current phase. */
function currentStep(log: string): string | null {
  const matches = log.match(/^### (.+)$/gm);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].replace(/^### /, "");
}

/**
 * Live output of the running task, shown on the Tasks page. Polls the live-log
 * endpoint on a short interval (codex streams chunk-by-chunk; the claude CLI
 * buffers --print output so its blocks land per step). Auto-scrolls while the
 * view is pinned to the bottom.
 */
export function LivePanel({ task, onChange }: { task: Task; onChange: () => void }) {
  const [log, setLog] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"inject" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);
  const id = task.frontmatter.id;

  useEffect(() => {
    let alive = true;
    const tick = () => {
      void api
        .liveLog(id)
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
  }, [id]);

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
      await api.injectPrompt(id, text);
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
      await api.stopTask(id);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const step = currentStep(log);
  return (
    <section className="live-panel">
      <div className="live-head">
        <span className="live-dot" title="Streaming live" />
        <strong>Working on “{task.frontmatter.title}”</strong>
        {step && <span className="live-step">{step}</span>}
        <button className="live-stop" onClick={stop} disabled={busy !== null}>
          {busy === "stop" ? "Stopping…" : "Stop"}
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
      </div>
      {error && <p className="error live-error">{error}</p>}
    </section>
  );
}
