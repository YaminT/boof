import { Button } from "../ui/button.js";
import type { HarnessStatus } from "../api-types.js";
import type { HarnessesState } from "../useHarnesses.js";
import { useConnection } from "../lib/useConnection.js";
import { blockReason, summarize } from "../lib/doctor.js";
import { CheckRows } from "./CheckRows.js";
import { HarnessPanel } from "../settings/HarnessPanel.js";

/**
 * The full Doctor page, check by check. Only "boof cannot work" blocks the rest of the app (App
 * does the redirect); this page reports and offers the fixes.
 * Nothing here is a secret: install paths, versions and yes/no answers.
 */
export function DoctorPage({
  harnesses,
  pid,
  isDesktop,
  onContinue,
}: {
  harnesses: HarnessesState;
  /** The selected project, for the Settings links; null before one exists. */
  pid: string | null;
  isDesktop?: boolean;
  onContinue: () => void;
}) {
  const { status, loading, failed, denied, refresh } = harnesses;
  const { state: conn } = useConnection();
  if (denied) {
    return (
      <Shell>
        <p role="note" data-testid="doctor-denied" className="m-0">
          This key cannot read the Doctor. Ask the owner of this boof to check that a coding agent
          is ready (the Doctor page needs the settings:read scope).
        </p>
        <div>
          <Button onClick={onContinue}>Back to boof</Button>
        </div>
      </Shell>
    );
  }
  const summary = status ? summarize(status.checks) : null;
  const reason = status ? blockReason(status) : null;
  const ready = !!status && !reason;
  return (
    <Shell>
      {!status && loading && <p className="m-0 text-ink-muted">Checking this computer…</p>}
      {failed && !status && conn !== "live" && (
        <p className="m-0 text-ink-muted">
          {conn === "signed-out"
            ? "Sign in needed."
            : conn === "offline"
              ? "Offline. The checks run again when boof is back."
              : "Checking…"}
        </p>
      )}
      {failed && !status && conn === "live" && (
        <p className="m-0 text-attention">Could not run the checks. Try again.</p>
      )}
      {status && (
        <>
          <p
            data-testid={ready ? "doctor-all-set" : "doctor-blocked"}
            className={`m-0 text-[length:var(--text-section)] font-semibold ${ready ? "text-done" : "text-attention"}`}
          >
            {ready
              ? summary && summary.fails === 0 && summary.warns === 0
                ? "All set"
                : "All set: an agent is ready"
              : (reason ?? "Cannot run tasks yet")}
          </p>
          <CheckRows checks={status.checks} pid={pid} />
          <HarnessPanel
            status={status as HarnessStatus}
            loading={loading}
            failed={failed}
            {...(isDesktop ? { env: { isDesktop } } : {})}
            onRefresh={refresh}
          />
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {ready && <Button onClick={onContinue}>Back to boof</Button>}
        <Button variant="outline" disabled={loading} onClick={refresh}>
          Check again
        </Button>
        {!ready && status && (
          <span className="text-[length:var(--text-meta)] text-ink-muted">
            The rest of boof opens when this is fixed. Settings stays open.
          </span>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto my-[6vh] flex max-w-[720px] flex-col gap-4 rounded-[10px] border border-line bg-surface p-6 shadow-md">
      <h1 className="m-0 text-[length:var(--text-title,1.25rem)] font-semibold">Boof Doctor</h1>
      {children}
    </div>
  );
}
