import { api } from "../api.js";
import type { Settings } from "../types.js";

export function RunnerToggle({
  settings,
  report,
  onChange,
}: {
  settings: Settings;
  /** Short activity summary, e.g. "Working on …" or "3 queued". */
  report?: string;
  onChange: () => void;
}) {
  const enabled = settings.runner.enabled;
  const toggle = async () => {
    await api.updateSettings({ runner: { enabled: !enabled } });
    onChange();
  };
  return (
    <button
      className={`runner-toggle ${enabled ? "on" : "off"}`}
      onClick={toggle}
      title={enabled ? "Runner is running — click to pause" : "Runner is paused — click to start"}
    >
      <span className="runner-dot" />
      <span className="runner-text">
        <span className="runner-state">Runner {enabled ? "running" : "paused"}</span>
        {report ? <span className="runner-report">{report}</span> : null}
      </span>
    </button>
  );
}
