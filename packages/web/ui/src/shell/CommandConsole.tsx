import { useEffect, useRef, useState } from "react";
import { Input } from "@/ui/input";
import { useHeldScopes } from "../lib/useHeldScopes.js";
import type { CommandAction } from "../lib/command-actions.js";
import {
  appendOutput,
  pushHistory,
  recall,
  submitConsole,
  type Recall,
} from "../lib/console-session.js";

const NO_RECALL: Recall = { index: null, draft: "" };

/**
 * One-line command input at the bottom of the shell. It runs the same actions as the palette,
 * resolved deterministically (see `lib/console-command.ts`). History and output live for the
 * session only. `onAssistantRequest` is a seam for free text that is not a command; nothing
 * connects it yet, so unknown input just prints a hint.
 */
export function CommandConsole({
  actions,
  onAssistantRequest,
}: {
  actions: CommandAction[];
  onAssistantRequest?: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [recalled, setRecalled] = useState<Recall>(NO_RECALL);
  const [output, setOutput] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const held = useHeldScopes();
  const logRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const bottomNav = document.querySelector<HTMLElement>("[data-bottom-nav]");
    const update = () => {
      document.documentElement.style.setProperty(
        "--command-console-height",
        `${section.getBoundingClientRect().height}px`,
      );
      document.documentElement.style.setProperty(
        "--bottom-nav-height",
        `${bottomNav?.getBoundingClientRect().height ?? 0}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(section);
    if (bottomNav) observer.observe(bottomNav);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [output, open]);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setHistory((h) => pushHistory(h, text));
    setRecalled(NO_RECALL);
    setValue("");
    setBusy(true);
    const { outcome, line } = await submitConsole(text, actions, held);
    setBusy(false);
    if (outcome.kind === "unknown" && onAssistantRequest) {
      onAssistantRequest(text);
      setOutput((o) => appendOutput(o, `> ${text}`));
      return;
    }
    setOutput((o) => appendOutput(appendOutput(o, `> ${text}`), line));
    if (outcome.kind !== "ok") setOpen(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const r = recall(history, recalled, e.key === "ArrowUp" ? "up" : "down", value);
      setRecalled(r.state);
      setValue(r.text);
    }
  };

  const last = output[output.length - 1];
  return (
    <section
      ref={sectionRef}
      aria-label="Command console"
      className="sticky bottom-[var(--bottom-nav-height,0px)] z-30 -mx-4 border-t border-line bg-surface px-4 py-2 min-[720px]:bottom-0 min-[720px]:-mx-8 min-[720px]:px-8"
    >
      <div className="mx-auto w-full max-w-[1320px]">
        {open && (
          <div
            ref={logRef}
            role="log"
            aria-label="Console output"
            className="mb-2 max-h-40 overflow-y-auto rounded-lg bg-page p-2 font-mono text-[length:var(--text-meta)] text-ink-muted"
          >
            {output.length === 0 ? (
              <p>No output yet. Try /task, /queue, /stop, /open or a palette label.</p>
            ) : (
              output.map((l, i) => (
                <p key={i} className="break-words whitespace-pre-wrap">
                  {l}
                </p>
              ))
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="h-8 shrink-0 rounded-lg px-2 text-[length:var(--text-meta)] text-ink-muted hover:bg-accent hover:text-ink"
          >
            {open ? "Hide output" : "Output"}
          </button>
          <Input
            aria-label="Command"
            placeholder="Command, e.g. /queue fix login"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setRecalled(NO_RECALL);
            }}
            onKeyDown={onKeyDown}
            className="font-mono"
          />
        </div>
        {!open && last && (
          <p
            aria-live="polite"
            className="mt-1 truncate font-mono text-[length:var(--text-meta)] text-ink-muted"
          >
            {last}
          </p>
        )}
      </div>
    </section>
  );
}
