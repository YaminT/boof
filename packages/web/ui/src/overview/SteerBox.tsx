import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { api } from "../api.js";
import { act } from "../lib/act.js";

type Mode = "next-step" | "now";

/** Sends a prompt to a running task, for the next step or right now. */
export function SteerBox({
  pid,
  taskId,
  onSent,
  children,
}: {
  pid: string;
  taskId: string;
  onSent?: () => void;
  /** Extra controls placed after the send button. */
  children?: React.ReactNode;
}) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("next-step");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await act(() => api.injectPrompt(pid, taskId, text, mode), {
      success:
        mode === "now" ? "Sent. The agent picks it up now." : "Sent. It applies at the next step.",
      failure: "Could not send",
    });
    setSending(false);
    if (ok) {
      setPrompt("");
      onSent?.();
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
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
      {children}
    </form>
  );
}
