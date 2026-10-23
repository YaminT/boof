import { useState } from "react";
import { Modal } from "./Modal.js";
import { FolderOpenIcon } from "./Icons.js";
import { RunnerToggle } from "./RunnerToggle.js";
import { boofRunnerLogoUrl } from "../assets.js";
import { useWorkingDir } from "../useWorkingDir.js";
import type { Settings } from "@boof-runner/shared/schema";

/** Browser-only modal for typing a working-directory path. */
function WorkingDirModal({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: string;
  busy: boolean;
  onClose: () => void;
  onSave: (path: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal title="Change working directory" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
      >
        <label>
          Path (must be a git repo for isolated runs)
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="/Users/you/project"
          />
        </label>
        <div className="editor-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Top header bar: the current working directory, the runner on/off toggle, and
 * an open icon to change the directory.
 */
export function WorkingDirHeader({
  settings,
  runnerReport,
  onChange,
}: {
  settings: Settings;
  runnerReport?: string;
  onChange: () => void;
}) {
  const workingDir = settings.workingDirectory;
  const enabled = settings.runner.enabled;
  const { change, save, modalOpen, setModalOpen, busy } = useWorkingDir(workingDir, onChange);
  return (
    <header className={`topbar ${enabled ? "runner-on" : "runner-off"}`}>
      <RunnerToggle settings={settings} report={runnerReport} onChange={onChange} />
      <div className="topbar-right">
        <div className="topbar-dir" title={workingDir}>
          <span className="topbar-dir-label">Working directory</span>
          <span className="topbar-dir-path">{workingDir}</span>
        </div>
        <button
          className="icon-btn"
          onClick={change}
          title="Change working directory"
          aria-label="Change working directory"
        >
          <FolderOpenIcon />
        </button>
      </div>
      {modalOpen && (
        <WorkingDirModal
          initial={workingDir}
          busy={busy}
          onClose={() => setModalOpen(false)}
          onSave={save}
        />
      )}
    </header>
  );
}

/** First-run / unset gate: blocks the app until a working directory is chosen. */
export function WorkingDirGate({ onChange }: { onChange: () => void }) {
  const { change, save, busy, isDesktop } = useWorkingDir("", onChange);
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-logo" src={boofRunnerLogoUrl} alt="Boof Runner" />
        <h1>Welcome to Boof Runner</h1>
        <p className="muted">
          Choose the project folder Boof Runner should work in — this is where your tasks run, so it
          should be a git repository. You can change it anytime from the header.
        </p>
        {isDesktop ? (
          <button className="primary gate-choose" onClick={change} disabled={busy}>
            <FolderOpenIcon /> {busy ? "Saving…" : "Choose folder…"}
          </button>
        ) : (
          <form
            className="gate-form"
            onSubmit={(e) => {
              e.preventDefault();
              save(value);
            }}
          >
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="/Users/you/project"
            />
            <button type="submit" className="primary" disabled={busy || !value.trim()}>
              {busy ? "Saving…" : "Continue"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
