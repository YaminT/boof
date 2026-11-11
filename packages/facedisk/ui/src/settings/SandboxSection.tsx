import { useEffect, useState } from "react";
import type { SandboxSettings } from "@boof/heart/schema";
import { cn } from "../lib/utils.js";
import { api } from "../api.js";
import { errorMessage } from "../lib/act.js";
import {
  applySandboxMode,
  sandboxLists,
  sandboxStateText,
  type SandboxListResult,
} from "../lib/sandbox-ui.js";

const h2 = "m-0 text-[length:var(--text-section)] font-semibold";

export interface SandboxView {
  mode: "off" | "enforce";
  state: "off" | "ok" | "unavailable";
  reason: string;
}

/** The three lists and the switch, with no network calls. Tests render this. */
export function SandboxPanel({
  sandbox,
  status,
  onMode,
  onSaveLists,
}: {
  sandbox: Pick<SandboxSettings, "mode" | "readPaths" | "writePaths" | "denyTcpPorts">;
  status: SandboxView;
  onMode: (mode: "off" | "enforce") => Promise<{ ok: true } | { ok: false; reason: string }>;
  onSaveLists: (lists: Extract<SandboxListResult, { ok: true }>) => Promise<void>;
}) {
  const [read, setRead] = useState(sandbox.readPaths.join("\n"));
  const [write, setWrite] = useState(sandbox.writePaths.join("\n"));
  const [ports, setPorts] = useState(sandbox.denyTcpPorts.join("\n"));
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enforced = sandbox.mode === "enforce";

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#sandbox") return;
    document.getElementById("sandbox")?.scrollIntoView();
  }, []);

  const toggle = async () => {
    setBusy(true);
    const result = await onMode(enforced ? "off" : "enforce");
    setBusy(false);
    setRefusal(result.ok ? null : result.reason);
  };

  const save = async () => {
    const parsed = sandboxLists({ read, write, ports });
    if (!parsed.ok) {
      setProblems(parsed.problems);
      setSaveError(null);
      return;
    }
    setProblems([]);
    setBusy(true);
    try {
      await onSaveLists(parsed);
      setSaveError(null);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="sandbox" className="flex flex-col gap-3">
      <h2 className={h2}>Sandbox</h2>
      <button
        type="button"
        role="switch"
        aria-checked={enforced}
        aria-label="Sandbox task agents"
        disabled={busy}
        onClick={() => void toggle()}
        className="focus-ring flex h-9 w-fit items-center gap-2 rounded-lg px-2 text-[length:var(--text-row)] text-ink hover:bg-accent disabled:opacity-50"
      >
        <span
          aria-hidden
          className={cn("relative h-4 w-7 rounded-full", enforced ? "bg-accent-brand" : "bg-line")}
        >
          <span
            className={cn(
              "absolute top-0.5 size-3 rounded-full bg-surface",
              enforced ? "left-3.5" : "left-0.5",
            )}
          />
        </span>
        Sandbox task agents
      </button>
      <p className="m-0 text-[length:var(--text-row)] text-ink">{sandboxStateText(status)}</p>
      {refusal && (
        <p className="m-0 text-[length:var(--text-row)] text-attention" role="alert">
          {refusal}
        </p>
      )}
      <label className="flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium">
        Read-only folders
        <textarea
          aria-label="Read-only folders"
          className="min-h-16 w-full rounded-lg border border-input px-2.5 py-2"
          value={read}
          onChange={(e) => setRead(e.target.value)}
        />
        <span className="text-[length:var(--text-row)] font-normal text-ink-muted">
          One absolute path per line.
        </span>
      </label>
      <label className="flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium">
        Writable folders
        <textarea
          aria-label="Writable folders"
          className="min-h-16 w-full rounded-lg border border-input px-2.5 py-2"
          value={write}
          onChange={(e) => setWrite(e.target.value)}
        />
        <span className="text-[length:var(--text-row)] font-normal text-ink-muted">
          One absolute path per line.
        </span>
      </label>
      <label className="flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium">
        Blocked TCP ports
        <textarea
          aria-label="Blocked TCP ports"
          className="min-h-16 w-full rounded-lg border border-input px-2.5 py-2"
          value={ports}
          onChange={(e) => setPorts(e.target.value)}
        />
        <span className="text-[length:var(--text-row)] font-normal text-ink-muted">
          One port per line, from 1 to 65535.
        </span>
      </label>
      {problems.length > 0 && (
        <ul className="m-0 list-disc pl-5 text-[length:var(--text-row)] text-attention">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {saveError && (
        <p className="m-0 text-[length:var(--text-row)] text-attention" role="alert">
          {saveError}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void save()}
        className="h-7 rounded-lg border border-line px-2.5 text-[length:var(--text-row)]"
      >
        Save sandbox lists
      </button>
    </section>
  );
}

function viewFrom(sandbox: SandboxSettings, live: SandboxView | null): SandboxView {
  if (live) return live;
  if (sandbox.mode === "off") {
    return { mode: "off", state: "off", reason: "agents are not sandboxed" };
  }
  return { mode: "enforce", state: "unavailable", reason: "sandbox self-test has not run" };
}

/** Settings › Agents. The lists are their own draft and do not send `mode`. */
export function SandboxSection({
  sandbox,
  onSaved,
}: {
  sandbox: SandboxSettings;
  onSaved: () => void | Promise<void>;
}) {
  const [live, setLive] = useState<SandboxView | null>(null);
  const reload = () => {
    void api
      .runnerStatus()
      .then((status) => {
        if (!status.sandbox) return;
        setLive({
          mode: status.sandbox.mode,
          state: status.sandbox.state,
          reason: status.sandbox.reason,
        });
      })
      .catch(() => {});
  };
  useEffect(() => {
    reload();
  }, [sandbox.mode, sandbox.readPaths, sandbox.writePaths, sandbox.denyTcpPorts]);

  return (
    <SandboxPanel
      sandbox={sandbox}
      status={viewFrom(sandbox, live)}
      onMode={async (mode) => {
        const result = await applySandboxMode(mode, (next) =>
          api.updateSettings({ runner: { sandbox: { mode: next } } }),
        );
        if (result.ok) {
          await onSaved();
          reload();
        }
        return result;
      }}
      onSaveLists={async (lists) => {
        await api.updateSettings({
          runner: {
            sandbox: {
              readPaths: lists.readPaths,
              writePaths: lists.writePaths,
              denyTcpPorts: lists.denyTcpPorts,
            },
          },
        });
        await onSaved();
        reload();
      }}
    />
  );
}
