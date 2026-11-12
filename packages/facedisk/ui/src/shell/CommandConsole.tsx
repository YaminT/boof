import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/ui/input";
import type { PendingChangeView } from "../api-types.js";
import {
  PLACEHOLDER_ASSISTANT,
  PLACEHOLDER_COMMAND,
  mergeLines,
  planUnknownInput,
  refusalText,
  type LocalLine,
} from "../lib/assistant-console.js";
import { initialConciergeUi, type ConciergeUiState } from "../lib/concierge-session.js";
import { ConfirmChangeDialog } from "./ConfirmChangeDialog.js";
import { ConsoleLog } from "./ConsoleLog.js";
import { useHeldScopes } from "../lib/useHeldScopes.js";
import type { CommandAction } from "../lib/command-actions.js";
import {
  OUTPUT_MAX,
  pushHistory,
  recall,
  submitConsole,
  type ConsoleLine,
  type Recall,
} from "../lib/console-session.js";

const NO_RECALL: Recall = { index: null, draft: "" };

/** The assistant as the console sees it; `AppShell` builds it from `useConcierge`. */
export interface ConsoleAssistant {
  available: boolean;
  /** The server's reason when `available` is false, shown word for word. */
  reason: string | null;
  noProject: boolean;
  state: ConciergeUiState;
  ask(text: string): void;
  apply(id: string): Promise<void>;
  discard(id: string): void | Promise<void>;
  cancel(): void;
}

const IDLE: ConciergeUiState = initialConciergeUi(null);

/**
 * One-line command input at the bottom of the shell. It runs the same actions as the palette,
 * resolved deterministically (see `lib/console-command.ts`). History and output live for the
 * session only. Free text that is not a command goes to the assistant when there is one; the
 * answer streams into the output as plain text. Without the assistant the console is Console A.
 */
export function CommandConsole({
  actions,
  assistant,
}: {
  actions: CommandAction[];
  assistant?: ConsoleAssistant;
}) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [recalled, setRecalled] = useState<Recall>(NO_RECALL);
  const [local, setLocal] = useState<LocalLine[]>([]);
  const [reviewing, setReviewing] = useState<PendingChangeView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const assistantState = assistant?.state ?? IDLE;
  const assistantBusy = assistantState.busy;
  const output = useMemo(
    () => mergeLines(local, assistantState.lines),
    [local, assistantState.lines],
  );
  const hasPending = assistantState.pending.length > 0;
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

  useEffect(() => {
    if (!hasPending) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [hasPending]);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setHistory((h) => pushHistory(h, text));
    setRecalled(NO_RECALL);
    setValue("");
    setBusy(true);
    const { outcome, line, prefill } = await submitConsole(text, actions, held);
    setBusy(false);
    const at = assistantState.lines.length;
    const print = (...lines: ConsoleLine[]) =>
      setLocal((o) => [...o, ...lines.map((l) => ({ ...l, at }))].slice(-OUTPUT_MAX));
    const echoed: ConsoleLine = { kind: "input", text: `> ${text}` };
    if (outcome.kind === "suggest") {
      print(echoed, ...outcome.lines.map((text): ConsoleLine => ({ kind: "system", text })));
      if (prefill) setValue(prefill);
      setOpen(true);
      return;
    }
    if (outcome.kind === "unknown") {
      const plan = planUnknownInput(text, assistant, line);
      if (plan.kind === "ask") {
        setOpen(true);
        if (assistantBusy) {
          print(echoed, { kind: "system", text: refusalText("concierge_busy", "") });
        } else {
          assistant!.ask(text);
        }
        return;
      }
      print(echoed, ...plan.lines);
      setOpen(true);
      return;
    }
    print(echoed, line);
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
              <p>No output yet. Try /plan, /task, /queue, /stop, /open or a palette label.</p>
            ) : (
              <ConsoleLog
                lines={output}
                pending={assistantState.pending}
                now={now}
                onReview={setReviewing}
                onDiscard={(id) => void Promise.resolve(assistant?.discard(id)).catch(() => {})}
              />
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
            placeholder={assistant?.available ? PLACEHOLDER_ASSISTANT : PLACEHOLDER_COMMAND}
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
          {assistantBusy && (
            <>
              <span
                role="status"
                className="shrink-0 text-[length:var(--text-meta)] text-ink-muted"
              >
                Answering…
              </span>
              <button
                type="button"
                onClick={() => assistant?.cancel()}
                className="h-8 shrink-0 rounded-lg border border-line px-2 text-[length:var(--text-meta)] text-ink hover:bg-accent"
              >
                Stop
              </button>
            </>
          )}
        </div>
        {!open && last && (
          <p
            aria-live="polite"
            className="mt-1 truncate font-mono text-[length:var(--text-meta)] text-ink-muted"
          >
            {last.text}
          </p>
        )}
      </div>
      <ConfirmChangeDialog
        change={reviewing}
        onConfirm={(id) => assistant!.apply(id)}
        onDiscard={(id) => void Promise.resolve(assistant?.discard(id)).catch(() => {})}
        onCancel={() => setReviewing(null)}
      />
    </section>
  );
}
