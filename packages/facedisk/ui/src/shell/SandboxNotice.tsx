import { useEffect, useState } from "react";
import { api } from "../api.js";
import {
  applySandboxMode,
  dismissSandboxNotice,
  readSandboxNoticeDismissed,
  sandboxNoticeVisible,
} from "../lib/sandbox-ui.js";

/** The one line, plus Turn on and Dismiss. No network calls. */
export function SandboxNotice({
  onTurnOn,
  onDismiss,
  failure,
}: {
  onTurnOn: () => void;
  onDismiss: () => void;
  failure?: string | null;
}) {
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 text-[length:var(--text-row)] text-ink"
    >
      <span>Agents are not sandboxed.</span>
      <button type="button" onClick={onTurnOn} className="h-7 rounded-lg px-2.5">
        Turn on
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="h-7 rounded-lg border border-line px-2.5"
      >
        Dismiss
      </button>
      {failure && (
        <span className="text-attention" role="alert">
          {failure}
        </span>
      )}
    </div>
  );
}

/** Shown once while mode is off and the last check said enforce would work. */
export function SandboxNoticeHost({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<{ mode: string; offer: boolean } | null>(null);
  const [dismissed, setDismissed] = useState(() =>
    typeof window === "undefined" ? false : readSandboxNoticeDismissed(window.localStorage),
  );
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .runnerStatus()
      .then((result) => {
        if (!live || !result.sandbox) return;
        setStatus({ mode: result.sandbox.mode, offer: result.sandbox.offer === true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!status || !sandboxNoticeVisible({ mode: status.mode, offer: status.offer, dismissed })) {
    return null;
  }

  return (
    <SandboxNotice
      failure={failure}
      onDismiss={() => {
        dismissSandboxNotice(window.localStorage);
        setDismissed(true);
      }}
      onTurnOn={() => {
        void applySandboxMode("enforce", (mode) =>
          api.updateSettings({ runner: { sandbox: { mode } } }),
        ).then((result) => {
          if (!result.ok) {
            setFailure(result.reason);
            return;
          }
          setStatus({ mode: "enforce", offer: status.offer });
          onChanged();
        });
      }}
    />
  );
}
