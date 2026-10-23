import { useState } from "react";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { api } from "../api.js";
import { desktop } from "../desktop.js";
import { boofRunnerLogoUrl } from "../assets.js";
import { Modal } from "./Modal.js";
import { FolderOpenIcon } from "./Icons.js";
import { RunnerToggle } from "./RunnerToggle.js";

/** Form body shared by the modal and the first-run gate. */
function AddProjectForm({
  showDefaultOption,
  onAdded,
  onCancel,
}: {
  /** Offer "make default"; the first project becomes the default automatically. */
  showDefaultOption: boolean;
  onAdded: (project: Project) => void;
  onCancel?: () => void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(!showDefaultOption);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    if (!desktop) return;
    const picked = await desktop.pickDirectory(path || undefined);
    if (picked) setPath(picked);
  };

  const submit = async () => {
    const workingDirectory = path.trim();
    if (!workingDirectory) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        workingDirectory,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      if (makeDefault) await api.updateSettings({ defaultProject: project.id });
      onAdded(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Repository path (must be a git repository)
        <span className="path-row">
          <input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/project"
          />
          {desktop && (
            <button type="button" onClick={() => void browse()}>
              <FolderOpenIcon size={16} /> Browse…
            </button>
          )}
        </span>
      </label>
      <label>
        Name (optional)
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Defaults to the folder name"
        />
      </label>
      {showDefaultOption && (
        <label className="check">
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />
          Make this the default project
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary" disabled={busy || !path.trim()}>
          {busy ? "Adding…" : "Add project"}
        </button>
      </div>
    </form>
  );
}

export function AddProjectModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (project: Project) => void;
}) {
  return (
    <Modal title="Add project" onClose={onClose}>
      <AddProjectForm showDefaultOption onAdded={onAdded} onCancel={onClose} />
    </Modal>
  );
}

/** First-run gate: shown while there are zero projects. */
export function AddProjectGate({ onAdded }: { onAdded: (project: Project) => void }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-logo" src={boofRunnerLogoUrl} alt="Boof Runner" />
        <h1>Welcome to Boof Runner</h1>
        <p className="muted">
          Add the first project: a git repository Boof Runner should run tasks in. You can add more
          projects and switch between them from the header.
        </p>
        <AddProjectForm showDefaultOption={false} onAdded={onAdded} />
      </div>
    </div>
  );
}

/**
 * Top bar: runner banner on the left; project switcher, working directory and
 * "Add project" on the right.
 */
export function ProjectSwitcher({
  settings,
  projects,
  selected,
  runnerReport,
  onSelect,
  onAdded,
  onChange,
}: {
  settings: Settings;
  projects: Project[];
  selected: Project;
  runnerReport?: string;
  onSelect: (id: string) => void;
  onAdded: (project: Project) => void;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const enabled = settings.runner.enabled;
  return (
    <header className={`topbar ${enabled ? "runner-on" : "runner-off"}`}>
      <RunnerToggle settings={settings} report={runnerReport} onChange={onChange} />
      <div className="topbar-right">
        <label className="project-select">
          <span className="topbar-dir-label">Project</span>
          <select value={selected.id} onChange={(e) => onSelect(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.paused ? " (paused)" : ""}
              </option>
            ))}
          </select>
        </label>
        {selected.paused && <span className="paused-badge">Paused</span>}
        <div className="topbar-dir" title={selected.workingDirectory}>
          <span className="topbar-dir-label">Working directory</span>
          <span className="topbar-dir-path">
            <bdi>{selected.workingDirectory}</bdi>
          </span>
        </div>
        <button className="retry-btn" onClick={() => setAdding(true)}>
          Add project
        </button>
      </div>
      {adding && (
        <AddProjectModal
          onClose={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false);
            onAdded(p);
          }}
        />
      )}
    </header>
  );
}
