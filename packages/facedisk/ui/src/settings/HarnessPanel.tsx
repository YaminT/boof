import { Button } from "../ui/button.js";
import type { HarnessStatus } from "../api-types.js";
import { harnessRows, type HarnessEnv } from "../lib/harnesses.js";

/**
 * "Coding agents on this computer": which tools boof found, free of charge (it only asks each
 * program for its version). No hooks: the page passes in what it loaded.
 */
export function HarnessPanel({
  status,
  loading,
  failed,
  env,
  onRefresh,
}: {
  status: HarnessStatus | null;
  loading: boolean;
  failed: boolean;
  env?: HarnessEnv;
  onRefresh: () => void;
}) {
  const rows = status ? harnessRows(status, env) : [];
  return (
    <section aria-label="Coding agents on this computer" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">
          Coding agents on this computer
        </h2>
        <Button variant="outline" size="xs" disabled={loading} onClick={onRefresh}>
          Check again
        </Button>
      </div>
      {loading && !status && (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">Looking for agents…</p>
      )}
      {failed && (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          Could not look for agents. Try again.
        </p>
      )}
      {status && !status.anyInstalled && (
        <p className="m-0 text-[length:var(--text-row)] text-attention">
          No coding agent found. Install one below, then check again.
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(({ id, info, state }) => (
          <li
            key={id}
            data-testid={`harness-${id}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-row)]"
          >
            <strong className="text-[length:var(--text-body)]">{info.displayName}</strong>
            <span
              className={`font-medium ${state === "installed" ? "text-done" : state === "off-path" ? "text-attention" : "text-ink-muted"}`}
            >
              {state === "installed"
                ? "installed"
                : state === "off-path"
                  ? "found, not on PATH"
                  : "not found"}
            </span>
            {info.version && <span className="font-mono text-ink-muted">{info.version}</span>}
            {(info.path ?? info.foundOffPath) && (
              <span className="font-mono text-[length:var(--text-meta)] text-ink-muted">
                {info.foundOffPath ?? info.path}
              </span>
            )}
            {state !== "installed" && (
              <span className="basis-full text-[length:var(--text-meta)] text-ink-muted">
                {info.message}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
