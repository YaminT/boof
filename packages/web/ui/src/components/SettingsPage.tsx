import { useEffect, useState } from "react";
import { api } from "../api.js";
import { desktop } from "../desktop.js";
import { Modal } from "./Modal.js";
import { ClientsSection } from "./ClientsSection.js";
import type { Project, RoleAssignment, Settings, TokenUsage } from "@boof-runner/shared/schema";
import type { BudgetStatus, HealthResult, ModelDetail, ToolModelDetails } from "../api-types.js";
import { TodaySpend } from "./Budget.js";

/** Short chip text per model source; "built-in" avoids clashing with the "default" chip. */
const SOURCE_LABELS: Record<string, string> = {
  cli: "cli",
  default: "built-in",
  settings: "added",
};
const SOURCE_TITLES: Record<string, string> = {
  cli: "Reported by the tool's CLI",
  default: "From the tool's built-in model list",
  settings: "Added in Settings",
};

type Role = "planner" | "developer" | "observer" | "reviewer";
const ROLES: Role[] = ["planner", "developer", "observer", "reviewer"];

/** A blank field means "no limit"; otherwise a positive number of USD. */
function parseLimit(text: string, what: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a number above 0`);
  return n;
}

/** `codex=5` lines (or comma separated) to a tool -> USD map. */
function parseToolLimits(text: string): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const part of text.split(/[\n,]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const [tool, value] = entry.split("=").map((s) => s.trim());
    const limit = parseLimit(value ?? "", `Limit for ${tool || "tool"}`);
    if (!tool || limit === undefined) throw new Error(`Use tool=USD per line, got "${entry}"`);
    out[tool] = limit;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const toolLimitsText = (m: Record<string, number> | undefined) =>
  Object.entries(m ?? {})
    .map(([tool, usd]) => `${tool}=${usd}`)
    .join("\n");

function usageLine(usage: TokenUsage | null) {
  if (!usage) return "Loading…";
  return `Input: ${usage.inputTokens.toLocaleString()} · Output: ${usage.outputTokens.toLocaleString()} · Cost: $${usage.costUsd.toFixed(4)}${usage.known ? "" : " (no data yet)"}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "checked 3 min ago" text for a health check time, or null when there is none. */
function checkedAgo(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const mins = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return null;
  return mins < 1 ? "checked just now" : `checked ${mins} min ago`;
}

/** Role or project usage as shown on a model chip: "planner", or "alpha: developer". */
function usageLabel(usage: string): string {
  const m = /^project:([^:]+):(.+)$/.exec(usage);
  return m ? `${m[1]}: ${m[2]}` : usage;
}

/** Health badge for one tool: status, version and when the check ran. */
function HealthBadge({ health, checkedAt }: { health: HealthResult; checkedAt?: string }) {
  const ago = checkedAgo(checkedAt);
  return (
    <>
      <span
        className={`status-badge ${health.status === "available" ? "done" : "failed"}`}
        title={health.message}
      >
        {health.status}
      </span>
      {health.version && <span className="muted">version {health.version}</span>}
      {ago && <span className="muted">{ago}</span>}
    </>
  );
}

/** Tool + model selects for one role assignment. */
function RoleSelects({
  role,
  assignment,
  tools,
  models,
  allowNone,
  onTool,
  onModel,
  onAddModel,
}: {
  role: string;
  assignment: RoleAssignment | undefined;
  tools: string[];
  models: Record<string, string[]>;
  allowNone: boolean;
  onTool: (tool: string) => void;
  onModel: (model: string) => void;
  onAddModel: (tool: string) => void;
}) {
  return (
    <>
      <select
        aria-label={`${role} tool`}
        value={assignment?.tool ?? ""}
        onChange={(e) => onTool(e.target.value)}
      >
        {allowNone && <option value="">(none)</option>}
        {tools.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {assignment && (
        <>
          <select
            aria-label={`${role} model`}
            value={assignment.model}
            onChange={(e) => onModel(e.target.value)}
          >
            {(models[assignment.tool] ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button onClick={() => onAddModel(assignment.tool)}>+ model</button>
        </>
      )}
    </>
  );
}

export function SettingsPage({
  settings,
  projects,
  project,
  onChange,
}: {
  settings: Settings;
  /** Active projects (for the default-project select). */
  projects: Project[];
  /** The selected project, edited in the Project section. */
  project: Project;
  onChange: () => void;
}) {
  // ---- Global ----
  const [roles, setRoles] = useState<Settings["roles"]>(settings.roles);
  const [models, setModels] = useState<Record<string, string[]>>(
    withRoleModels(settings.models, settings.roles),
  );
  const [concurrency, setConcurrency] = useState(String(settings.runner.concurrency));
  const [defaultProject, setDefaultProject] = useState(settings.defaultProject ?? "");
  const [gate, setGate] = useState(settings.review?.gate ?? true);
  const [maxFixRounds, setMaxFixRounds] = useState(String(settings.review?.maxFixRounds ?? 2));
  const [onDone, setOnDone] = useState(settings.worktree?.onDone ?? "keep-branch");
  const [onFailure, setOnFailure] = useState(settings.worktree?.onFailure ?? "keep");
  const [transient, setTransient] = useState(String(settings.retries?.transient ?? 2));
  const [perTask, setPerTask] = useState(String(settings.budget?.perTaskUsd ?? ""));
  const [perDay, setPerDay] = useState(String(settings.budget?.perDayUsd ?? ""));
  const [perProjectDay, setPerProjectDay] = useState(
    String(settings.budget?.perProjectDayUsd ?? ""),
  );
  const [perToolDay, setPerToolDay] = useState(toolLimitsText(settings.budget?.perToolDayUsd));
  const [onExceed, setOnExceed] = useState(settings.budget?.onExceed ?? "pause");
  const [timezone, setTimezone] = useState(settings.budget?.timezone ?? "");
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [health, setHealth] = useState<Record<string, HealthResult>>({});
  const [details, setDetails] = useState<Record<string, ToolModelDetails> | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [projectUsage, setProjectUsage] = useState<TokenUsage | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelDialogTool, setModelDialogTool] = useState<string | null>(null);
  const [newModel, setNewModel] = useState("");

  // ---- Project ----
  const [name, setName] = useState(project.name);
  const [workingDir, setWorkingDir] = useState(project.workingDirectory);
  const [paused, setPaused] = useState(project.paused);
  const [defaultBase, setDefaultBase] = useState(project.defaultBase ?? "");
  const [overrides, setOverrides] = useState<NonNullable<Project["roles"]>>(project.roles ?? {});
  const pb = project.budget;
  const [pbPerTask, setPbPerTask] = useState(String(pb?.perTaskUsd ?? ""));
  const [pbPerDay, setPbPerDay] = useState(String(pb?.perProjectDayUsd ?? ""));
  const [pbPerTool, setPbPerTool] = useState(toolLimitsText(pb?.perToolDayUsd));
  const [pbOnExceed, setPbOnExceed] = useState<string>(pb?.onExceed ?? "");
  const [projectSaved, setProjectSaved] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  useEffect(() => {
    setRoles(settings.roles);
    setConcurrency(String(settings.runner.concurrency));
    setDefaultProject(settings.defaultProject ?? "");
    setModels((m) => withRoleModels(mergeModels(settings.models, m), settings.roles));
  }, [settings]);

  useEffect(() => {
    setName(project.name);
    setWorkingDir(project.workingDirectory);
    setPaused(project.paused);
    setDefaultBase(project.defaultBase ?? "");
    setOverrides(project.roles ?? {});
    setPbPerTask(String(project.budget?.perTaskUsd ?? ""));
    setPbPerDay(String(project.budget?.perProjectDayUsd ?? ""));
    setPbPerTool(toolLimitsText(project.budget?.perToolDayUsd));
    setPbOnExceed(project.budget?.onExceed ?? "");
  }, [project]);

  useEffect(() => {
    let cancelled = false;

    // Model details list no probes, so they load at once. They load again after the health check
    // so the badges show the time of the check that just ran.
    const loadDetails = () =>
      api
        .modelDetails()
        .then((tools) => {
          if (!cancelled) setDetails(tools);
        })
        .catch(() => {});
    void loadDetails();
    void api.health().then((result) => {
      if (!cancelled) {
        setHealth(result);
        void loadDetails();
      }
    });
    void api
      .usage()
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch(() => {});
    void api
      .budget()
      .then((result) => {
        if (!cancelled) setBudget(result);
      })
      .catch(() => {});
    void api
      .models()
      .then((fetched) => {
        if (cancelled) return;
        setModels((m) => withRoleModels(mergeModels(fetched, m), settings.roles));
      })
      .catch((err) => {
        if (!cancelled) setModelsError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProjectUsage(null);
    void api
      .projectUsage(project.id)
      .then((result) => {
        if (!cancelled) setProjectUsage(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const tools = Object.keys(models);

  const setRole = (role: Role, patch: Partial<RoleAssignment>) =>
    setRoles((r) => ({ ...r, [role]: { ...r[role], ...patch } as RoleAssignment }));

  // The observer is optional: "(none)" removes it from the saved roles.
  const clearObserver = () =>
    setRoles((r) => {
      const { observer: _unset, ...rest } = r;
      return rest;
    });

  const setOverride = (role: Role, next: RoleAssignment | null) =>
    setOverrides((o) => {
      const { [role]: _drop, ...rest } = o;
      return next ? { ...rest, [role]: next } : rest;
    });

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

  const flash = (set: (v: boolean) => void) => {
    set(true);
    setTimeout(() => set(false), 1500);
  };

  const saveGlobal = async () => {
    setSaveError(null);
    try {
      const limits = {
        perTaskUsd: parseLimit(perTask, "Per-task limit"),
        perDayUsd: parseLimit(perDay, "Per-day limit"),
        perProjectDayUsd: parseLimit(perProjectDay, "Per-project day limit"),
        perToolDayUsd: parseToolLimits(perToolDay),
        timezone: timezone.trim() || undefined,
      };
      await api.updateSettings({
        budget: { ...limits, onExceed } as NonNullable<Settings["budget"]>,
        roles,
        models,
        runner: { concurrency: Math.max(1, Math.floor(Number(concurrency) || 1)) },
        defaultProject: defaultProject || null,
        review: {
          ...settings.review,
          gate,
          maxFixRounds: Math.max(0, Math.floor(Number(maxFixRounds) || 0)),
        } as NonNullable<Settings["review"]>,
        worktree: { ...settings.worktree, onDone, onFailure } as NonNullable<Settings["worktree"]>,
        retries: {
          ...settings.retries,
          transient: Math.max(0, Math.floor(Number(transient) || 0)),
        } as NonNullable<Settings["retries"]>,
      });
      flash(setSaved);
      onChange();
    } catch (err) {
      setSaveError(errorText(err));
    }
  };

  const saveProject = async () => {
    setProjectError(null);
    try {
      const own = {
        perTaskUsd: parseLimit(pbPerTask, "Per-task limit"),
        perProjectDayUsd: parseLimit(pbPerDay, "Per-day limit"),
        perToolDayUsd: parseToolLimits(pbPerTool),
        onExceed: pbOnExceed || undefined,
      };
      const hasBudget = Object.values(own).some((v) => v !== undefined);
      await api.updateProject(project.id, {
        budget: hasBudget ? (own as NonNullable<Project["budget"]>) : null,
        name: name.trim() || project.name,
        ...(workingDir.trim() && workingDir.trim() !== project.workingDirectory
          ? { workingDirectory: workingDir.trim() }
          : {}),
        paused,
        defaultBase: defaultBase.trim() || null,
        roles: Object.keys(overrides).length > 0 ? overrides : null,
      });
      flash(setProjectSaved);
      onChange();
    } catch (err) {
      setProjectError(errorText(err));
    }
  };

  const browse = async () => {
    if (!desktop) return;
    const picked = await desktop.pickDirectory(workingDir || undefined);
    if (picked) setWorkingDir(picked);
  };

  const archive = async () => {
    try {
      await api.archiveProject(project.id);
      setArchiveOpen(false);
      onChange();
    } catch (err) {
      setArchiveOpen(false);
      setProjectError(errorText(err));
    }
  };

  return (
    <div className="settings-page">
      <h2 className="settings-heading">Global</h2>

      <section>
        <h3>Runner</h3>
        <label>
          Concurrency (tasks at once, at most one per project)
          <input
            type="number"
            min={1}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
          />
        </label>
        <label>
          Default project
          <select value={defaultProject} onChange={(e) => setDefaultProject(e.target.value)}>
            <option value="">(none)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
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
        {modelsLoading && <p className="muted">Fetching models from Claude, Codex and OpenCode…</p>}
        {modelsError && <p className="muted">Model refresh failed: {modelsError}</p>}
        <div className="model-list">
          {tools.map((tool) => {
            const info = details?.[tool];
            const toolHealth = health[tool];
            return (
              <div key={tool} className="model-group">
                <div className="model-group-head">
                  <strong>{info?.displayName ?? tool}</strong>
                  {toolHealth && (
                    <HealthBadge health={toolHealth} checkedAt={info?.health?.checkedAt} />
                  )}
                </div>
                <div className="model-chips">
                  {(models[tool] ?? []).map((m) => {
                    // A model added in this session is not saved yet, so it is a settings model.
                    const meta: ModelDetail | undefined =
                      info && (info.models.find((d) => d.id === m) ?? unsavedModel(m));
                    return (
                      <span key={m} className="model-chip">
                        {m}
                        {meta && (
                          <span className="status-badge" title={SOURCE_TITLES[meta.source]}>
                            {SOURCE_LABELS[meta.source]}
                          </span>
                        )}
                        {meta?.isDefault && <span className="badge">default</span>}
                        {meta?.usedBy.map((u) => (
                          <span key={u} className="paused-badge" title={u}>
                            {usageLabel(u)}
                          </span>
                        ))}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {tools.length === 0 && <p className="muted">No models detected yet.</p>}
        </div>
      </section>

      <section>
        <h3>Roles</h3>
        {ROLES.map((role) => (
          <div key={role} className="role-row">
            <span className="role-name">{role}</span>
            <RoleSelects
              role={role}
              assignment={roles[role]}
              tools={tools}
              models={models}
              allowNone={role === "observer"}
              onTool={(tool) => {
                if (!tool) return clearObserver();
                setRole(role, { tool, model: models[tool]?.[0] ?? roles[role]?.model ?? "" });
              }}
              onModel={(model) => setRole(role, { model })}
              onAddModel={openAddModel}
            />
          </div>
        ))}
      </section>

      <section>
        <h3>Review</h3>
        <label className="check">
          <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
          Only a reviewer approval finishes a task as done
        </label>
        <label>
          Max fix rounds per reviewing role
          <input
            type="number"
            min={0}
            value={maxFixRounds}
            onChange={(e) => setMaxFixRounds(e.target.value)}
          />
        </label>
      </section>

      <section>
        <h3>Worktree</h3>
        <label>
          When a task is done
          <select value={onDone} onChange={(e) => setOnDone(e.target.value as typeof onDone)}>
            <option value="keep-branch">Keep branch, remove directory</option>
            <option value="keep">Keep branch and directory</option>
            <option value="delete">Delete both</option>
          </select>
        </label>
        <label>
          When a task fails
          <select
            value={onFailure}
            onChange={(e) => setOnFailure(e.target.value as typeof onFailure)}
          >
            <option value="keep">Keep branch and directory</option>
            <option value="delete">Delete both</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Retries</h3>
        <label>
          Retries per step after a transient failure
          <input
            type="number"
            min={0}
            value={transient}
            onChange={(e) => setTransient(e.target.value)}
          />
        </label>
      </section>

      <section>
        <h3>Budget</h3>
        <p className="muted">
          Limits in USD; leave a field empty for no limit. A running step is never stopped: limits
          are checked between steps, so a step can go over. Day limits block new work until the day
          resets.
        </p>
        <label>
          Per task (one run)
          <input
            inputMode="decimal"
            value={perTask}
            onChange={(e) => setPerTask(e.target.value)}
            placeholder="no limit"
          />
        </label>
        <label>
          Per day, all work
          <input
            inputMode="decimal"
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
            placeholder="no limit"
          />
        </label>
        <label>
          Per day, each project
          <input
            inputMode="decimal"
            value={perProjectDay}
            onChange={(e) => setPerProjectDay(e.target.value)}
            placeholder="no limit"
          />
        </label>
        <label>
          Per day, each tool (one <code>tool=USD</code> per line)
          <textarea
            rows={2}
            value={perToolDay}
            onChange={(e) => setPerToolDay(e.target.value)}
            placeholder={"codex=5\nclaude-code=10"}
          />
        </label>
        <label>
          When a limit is spent
          <select value={onExceed} onChange={(e) => setOnExceed(e.target.value as typeof onExceed)}>
            <option value="pause">Fail the task, keep its worktree (pause)</option>
            <option value="fail">Fail the task, follow the worktree failure setting</option>
          </select>
        </label>
        <label>
          Time zone for a day (IANA name, empty uses the server's)
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="e.g. Europe/Berlin"
          />
        </label>
      </section>

      <section>
        <h3>Token usage</h3>
        <p>
          <strong>{project.name}:</strong> {usageLine(projectUsage)}
        </p>
        <p>
          <strong>All projects:</strong> {usageLine(usage)}
        </p>
        <TodaySpend budget={budget} projectId={project.id} />
      </section>

      <div className="editor-actions">
        <button className="primary" onClick={() => void saveGlobal()}>
          Save global settings
        </button>
        {saved && <span className="saved">Saved ✓</span>}
        {saveError && (
          <span className="error" role="alert">
            {saveError}
          </span>
        )}
      </div>

      <ClientsSection />

      <section className="placeholder-card">
        <h3>better-ccflare</h3>
        <p className="muted">
          Consider installing better-ccflare to proxy and observe Claude usage.{" "}
          <a href="https://github.com/snipeship/ccflare" target="_blank" rel="noreferrer">
            Learn more
          </a>
        </p>
      </section>

      <h2 className="settings-heading">Project: {project.name}</h2>

      <section>
        <h3>General</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Working directory (must be a git repo for isolated runs)
          <span className="path-row">
            <input value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} />
            {desktop && (
              <button type="button" className="btn-secondary" onClick={() => void browse()}>
                Browse…
              </button>
            )}
          </span>
        </label>
        <label>
          Default base branch (empty uses the repository's current branch)
          <input
            value={defaultBase}
            onChange={(e) => setDefaultBase(e.target.value)}
            placeholder="e.g. main"
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
          Paused (the runner skips this project)
        </label>
      </section>

      <section>
        <h3>Role overrides</h3>
        <p className="muted">Unchecked roles use the global assignment above.</p>
        {ROLES.map((role) => {
          const override = overrides[role];
          const inherited = override === undefined;
          return (
            <div key={role} className="role-row">
              <span className="role-name">{role}</span>
              <label className="check inherit">
                <input
                  type="checkbox"
                  checked={inherited}
                  onChange={(e) => {
                    if (e.target.checked) return setOverride(role, null);
                    const base = roles[role];
                    const tool = base?.tool ?? tools[0] ?? "";
                    setOverride(role, {
                      tool,
                      model: base?.model ?? models[tool]?.[0] ?? "",
                    });
                  }}
                />
                Inherit global
              </label>
              {override && (
                <RoleSelects
                  role={`${role} override`}
                  assignment={override}
                  tools={tools}
                  models={models}
                  allowNone={false}
                  onTool={(tool) =>
                    setOverride(role, { tool, model: models[tool]?.[0] ?? override.model })
                  }
                  onModel={(model) => setOverride(role, { ...override, model })}
                  onAddModel={openAddModel}
                />
              )}
            </div>
          );
        })}
      </section>

      <section>
        <h3>Budget override</h3>
        <p className="muted">
          Empty fields use the global budget. The day limit counts this project's spend; a tool
          limit caps this project's spend on that tool.
        </p>
        <label>
          Per task (one run)
          <input
            inputMode="decimal"
            value={pbPerTask}
            onChange={(e) => setPbPerTask(e.target.value)}
            placeholder="inherit"
          />
        </label>
        <label>
          Per day
          <input
            inputMode="decimal"
            value={pbPerDay}
            onChange={(e) => setPbPerDay(e.target.value)}
            placeholder="inherit"
          />
        </label>
        <label>
          Per day, each tool (one <code>tool=USD</code> per line)
          <textarea rows={2} value={pbPerTool} onChange={(e) => setPbPerTool(e.target.value)} />
        </label>
        <label>
          When a limit is spent
          <select value={pbOnExceed} onChange={(e) => setPbOnExceed(e.target.value)}>
            <option value="">Inherit global</option>
            <option value="pause">Fail the task, keep its worktree (pause)</option>
            <option value="fail">Fail the task, follow the worktree failure setting</option>
          </select>
        </label>
      </section>

      <div className="editor-actions">
        <button className="primary" onClick={() => void saveProject()}>
          Save project
        </button>
        {projectSaved && <span className="saved">Saved ✓</span>}
        {projectError && (
          <span className="error" role="alert">
            {projectError}
          </span>
        )}
      </div>

      <section className="danger-zone">
        <h3>Archive project</h3>
        <p className="muted">
          Hides the project and stops the runner from working on it. Its tasks and files are kept.
        </p>
        <button className="danger" onClick={() => setArchiveOpen(true)}>
          Archive project…
        </button>
      </section>

      {archiveOpen && (
        <Modal title="Archive project" onClose={() => setArchiveOpen(false)}>
          <p>
            Archive <strong>{project.name}</strong>? It disappears from the project list and the
            runner stops picking up its tasks.
          </p>
          <div className="editor-actions">
            <button onClick={() => setArchiveOpen(false)}>Cancel</button>
            <button className="danger" onClick={() => void archive()}>
              Archive
            </button>
          </div>
        </Modal>
      )}

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

function unsavedModel(id: string): ModelDetail {
  return { id, source: "settings", isDefault: false, usedBy: [] };
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
    if (!assignment) continue;
    out[assignment.tool] = unique([...(out[assignment.tool] ?? []), assignment.model]);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
