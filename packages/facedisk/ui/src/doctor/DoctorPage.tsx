import { Button } from "../ui/button.js";
import type { HarnessStatus } from "../api-types.js";
import type { HarnessesState } from "../useHarnesses.js";
import { fixRoute, summarize } from "../lib/doctor.js";
import { formatRoute } from "../lib/route.js";
import { HarnessPanel } from "../settings/HarnessPanel.js";

const MARK = { pass: "✓ pass", warn: "! warning", fail: "✗ fail" } as const;
const TONE = { pass: "text-done", warn: "text-attention", fail: "text-attention" } as const;

/**
 * The first page of the app: what boof needs to run tasks, check by check. No agent ready blocks
 * the rest of the app (App does the redirect); this page only reports and offers the fixes.
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
  if (denied) {
    return (
      <Shell>
        <p role="note" data-testid="doctor-denied" className="m-0">
          This key cannot read the setup checks. Ask the owner of this boof to check that a coding
          agent is ready (the Doctor page needs the settings:read scope).
        </p>
        <div>
          <Button onClick={onContinue}>Continue</Button>
        </div>
      </Shell>
    );
  }
  const summary = status ? summarize(status.checks) : null;
  const ready = !!status?.anyReady;
  return (
    <Shell>
      {!status && loading && <p className="m-0 text-ink-muted">Checking this computer…</p>}
      {failed && !status && (
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
              : "Cannot run tasks yet: no coding agent is ready"}
          </p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {status.checks.map((c) => {
              const fix = fixRoute(c.fixPage, pid);
              return (
                <li
                  key={c.id}
                  data-testid={`check-${c.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[length:var(--text-row)]"
                >
                  <strong className="text-[length:var(--text-body)]">{c.label}</strong>
                  <span className={`font-medium ${TONE[c.status]}`}>{MARK[c.status]}</span>
                  <span className="text-ink-muted">{c.message}</span>
                  {c.status !== "pass" && (c.fixHint || fix) && (
                    <span className="basis-full text-[length:var(--text-meta)]">
                      {c.fixHint}
                      {fix && (
                        <>
                          {c.fixHint ? " " : ""}
                          <a href={formatRoute(fix)} className="text-accent underline">
                            Open Settings
                          </a>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
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
        <Button disabled={!ready} onClick={onContinue}>
          Continue
        </Button>
        <Button variant="outline" disabled={loading} onClick={refresh}>
          Check again
        </Button>
        {!ready && status && (
          <span className="text-[length:var(--text-meta)] text-ink-muted">
            Continue unlocks when an agent is ready.
          </span>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto my-[6vh] flex max-w-[720px] flex-col gap-4 rounded-[10px] border border-line bg-surface p-6 shadow-md">
      <h1 className="m-0 text-[length:var(--text-title,1.25rem)] font-semibold">
        Boof setup check
      </h1>
      {children}
    </div>
  );
}
