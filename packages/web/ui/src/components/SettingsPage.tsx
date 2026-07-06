import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Modal } from "./Modal.js";
import type { HealthResult, RoleAssignment, Settings, TokenUsage } from "../types.js";

type Role = "planner" | "developer" | "reviewer";
const ROLES: Role[] = ["planner", "developer", "reviewer"];

export function SettingsPage({ settings, onChange }: { settings: Settings; onChange: () => void }) {
  const [workingDir, setWorkingDir] = useState(settings.workingDirectory);
  const [subdir, setSubdir] = useState(settings.selectedSubdirectory ?? "");
  const [roles, setRoles] = useState<Settings["roles"]>(settings.roles);
  const [models, setModels] = useState<Record<string, string[]>>(
    withRoleModels(settings.models, settings.roles),
  );
  const [health, setHealth] = useState<Record<string, HealthResult>>({});
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [saved, setSaved] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelDialogTool, setModelDialogTool] = useState<string | null>(null);
  const [newModel, setNewModel] = useState("");

  useEffect(() => {
    setWorkingDir(settings.workingDirectory);
    setSubdir(settings.selectedSubdirectory ?? "");
    setRoles(settings.roles);
    setModels((m) => withRoleModels(mergeModels(settings.models, m), settings.roles));
  }, [settings]);

  useEffect(() => {
    let cancelled = false;

    void api.health().then((result) => {
      if (!cancelled) setHealth(result);
    });
    void api.usage().then((result) => {
      if (!cancelled) setUsage(result);
    });
    void api
      .models()
      .then((fetched) => {
        if (cancelled) return;
        setModels((m) => withRoleModels(mergeModels(fetched, m), settings.roles));
      })
      .catch((err) => {
        if (!cancelled) setModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const tools = Object.keys(models);

  const setRole = (role: Role, patch: Partial<RoleAssignment>) =>
    setRoles((r) => ({ ...r, [role]: { ...r[role], ...patch } }));

  const openAddModel = (tool: string) => {
    setNewModel("");
    setModelDialogTool(tool);
  };

  const confirmAddModel = () => {
    const tool = modelDialogTool;
    const name = newModel.trim();
    if (!tool || !name) return;
    setModels((m) => ({ ...m, [tool]: [...new Set([...(m[tool] ?? []), name])] }));
    setModelDialogTool(null);
  };

  const save = async () => {
    await api.updateSettings({
      workingDirectory: workingDir,
      selectedSubdirectory: subdir || null,
      roles,
      models,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    onChange();
  };

  return (
    <div className="settings-page">
      <section>
        <h3>Working directory</h3>
        <label>
          Path (must be a git repo for isolated runs)
          <input value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} />
        </label>
        <label>
          Subdirectory (optional)
          <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="(none)" />
        </label>
      </section>

      <section>
        <h3>Health check</h3>
        <ul className="health">
          {Object.entries(health).map(([id, h]) => (
            <li key={id} className={h.status}>
              <strong>{id}</strong>: {h.status}
              {h.version ? ` (${h.version})` : ""} — <span className="muted">{h.message}</span>
            </li>
          ))}
          {Object.keys(health).length === 0 && <li className="muted">Checking…</li>}
        </ul>
      </section>

      <section>
        <h3>Available models</h3>
        {modelsLoading && <p className="muted">Fetching models from Claude and Codex…</p>}
        {modelsError && <p className="muted">Model refresh failed: {modelsError}</p>}
        <div className="model-list">
          {tools.map((tool) => (
            <div key={tool} className="model-group">
              <strong>{tool}</strong>
              <div className="model-chips">
                {(models[tool] ?? []).map((m) => (
                  <span key={m}>{m}</span>
                ))}
              </div>
            </div>
          ))}
          {tools.length === 0 && <p className="muted">No models detected yet.</p>}
        </div>
      </section>

      <section>
        <h3>Roles</h3>
        {ROLES.map((role) => (
          <div key={role} className="role-row">
            <span className="role-name">{role}</span>
            <select
              value={roles[role].tool}
              onChange={(e) => {
                const tool = e.target.value;
                setRole(role, { tool, model: models[tool]?.[0] ?? roles[role].model });
              }}
            >
              {tools.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={roles[role].model}
              onChange={(e) => setRole(role, { model: e.target.value })}
            >
              {(models[roles[role].tool] ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button onClick={() => openAddModel(roles[role].tool)}>+ model</button>
          </div>
        ))}
      </section>

      <section>
        <h3>Token usage</h3>
        {usage ? (
          <p>
            Input: {usage.inputTokens.toLocaleString()} · Output:{" "}
            {usage.outputTokens.toLocaleString()} · Cost: ${usage.costUsd.toFixed(4)}{" "}
            {usage.known ? "" : "(no data yet)"}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section className="placeholder-card">
        <h3>Block hours</h3>
        <p className="muted">
          Placeholder — time windows when the runner idles. Coming in a later iteration.
        </p>
      </section>

      <section className="placeholder-card">
        <h3>better-ccflare</h3>
        <p className="muted">
          Consider installing better-ccflare to proxy and observe Claude usage.{" "}
          <a href="https://github.com/snipeship/ccflare" target="_blank" rel="noreferrer">
            Learn more
          </a>
        </p>
      </section>

      <div className="editor-actions">
        <button className="primary" onClick={save}>
          Save settings
        </button>
        {saved && <span className="saved">Saved ✓</span>}
      </div>

      {modelDialogTool && (
        <Modal title={`Add model for ${modelDialogTool}`} onClose={() => setModelDialogTool(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmAddModel();
            }}
          >
            <label>
              Model name
              <input
                autoFocus
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="e.g. opus-4.8"
              />
            </label>
            <div className="editor-actions">
              <button type="button" onClick={() => setModelDialogTool(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!newModel.trim()}>
                Add model
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function mergeModels(...maps: Record<string, string[]>[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const map of maps) {
    for (const [tool, models] of Object.entries(map)) {
      out[tool] = unique([...(out[tool] ?? []), ...models]);
    }
  }
  return out;
}

function withRoleModels(
  models: Record<string, string[]>,
  roles: Settings["roles"],
): Record<string, string[]> {
  const out = mergeModels(models);
  for (const role of ROLES) {
    const assignment = roles[role];
    out[assignment.tool] = unique([...(out[assignment.tool] ?? []), assignment.model]);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
