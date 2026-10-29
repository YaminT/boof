import { useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { api, type TaskView } from "../api.js";
import { act } from "../lib/act.js";
import { currentStep, tailLines } from "../lib/log-tail.js";
import { formatRoute } from "../lib/route.js";
import { formatElapsed } from "../lib/time.js";
import { StopTaskDialog } from "../shell/StopTaskDialog.js";
import { useElapsed } from "./useElapsed.js";

type Mode = "next-step" | "now";

/** One running task: step, elapsed time, the tail of its log, a steer box and Stop. */
export function RunningCard({
  pid,
  task,
  onChange,
}: {
  pid: string;
  task: TaskView;
  onChange: () => void;
}) {
  const id = task.frontmatter.id;
  const [log, setLog] = useState("");
  const [logFailed, setLogFailed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("next-step");
  const [sending, setSending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const elapsed = useElapsed(pid, id, true);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .liveLog(pid, id)
        .then((r) => {
          if (!alive) return;
          setLog(r.log);
          setLogFailed(false);
        })
        .catch(() => alive && setLogFailed(true));
    };
    tick();
    const timer = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pid, id]);

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await act(() => api.injectPrompt(pid, id, text, mode), {
      success:
        mode === "now" ? "Sent. The agent picks it up now." : "Sent. It applies at the next step.",
      failure: "Could not send",
    });
    setSending(false);
    if (ok) {
      setPrompt("");
      onChange();
    }
  };

  const step = currentStep(log);
  const tail = tailLines(log, 6);
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-[7px] size-2 shrink-0 rounded-full bg-running motion-safe:animate-pulse"
        />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 truncate text-[length:var(--text-body)] font-semibold">
            {task.frontmatter.title}
          </h3>
          <p className="m-0 text-[length:var(--text-meta)] text-ink-muted">
            {step ? `${step}, ` : ""}
            running {elapsed !== null ? formatElapsed(elapsed) : ""}
          </p>
        </div>
        <a
          href={formatRoute({ name: "task", pid, taskId: id, view: "edit" })}
          className="shrink-0 text-[length:var(--text-row)]"
        >
          Open
        </a>
      </div>

      <pre
        aria-label="Latest live output"
        className="mt-3 mb-0 min-h-[6.5rem] overflow-hidden rounded-md border border-line bg-page px-3 py-2 font-mono text-[length:var(--text-meta)] leading-[1.4] break-words whitespace-pre-wrap text-ink"
      >
        {logFailed
          ? "Live output unavailable. Retrying…"
          : tail.length > 0
            ? tail.join("\n")
            : "Waiting for output…"}
      </pre>

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="Prompt for the agent"
          placeholder="Tell the agent something"
          className="min-w-[12rem] flex-1 text-[length:var(--text-row)]"
        />
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="When to apply the prompt"
          value={[mode]}
          onValueChange={(v) => v.length > 0 && setMode(v[0] as Mode)}
        >
          <ToggleGroupItem
            value="next-step"
            className="data-[pressed]:bg-accent-brand data-[pressed]:text-primary-foreground"
          >
            At next step
          </ToggleGroupItem>
          <ToggleGroupItem
            value="now"
            className="data-[pressed]:bg-accent-brand data-[pressed]:text-primary-foreground"
          >
            Now
          </ToggleGroupItem>
        </ToggleGroup>
        <Button type="submit" disabled={sending || !prompt.trim()}>
          Send to agent
        </Button>
        <Button type="button" variant="destructive" onClick={() => setConfirmStop(true)}>
          Stop
        </Button>
      </form>

      <StopTaskDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        onConfirm={() => {
          setConfirmStop(false);
          void act(() => api.stopTask(pid, id), {
            success: "Stop requested",
            failure: "Could not stop",
          }).then(onChange);
        }}
      />
    </section>
  );
}
