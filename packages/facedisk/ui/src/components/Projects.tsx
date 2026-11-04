import { useState, type ReactNode } from "react";
import type { Project } from "@boof/heart/schema";
import { api, ApiError } from "../api.js";
import { desktop } from "../desktop.js";
import { boofRunnerLogoUrl } from "../assets.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { NativeSelect } from "@/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import {
  autoPathHint,
  EMPTY_PROJECT_FORM,
  needsConfirm,
  NOT_EMPTY_NOTICE,
  projectFormIssues,
  submitLabel,
  toCreateProjectInput,
  type ProjectFormState,
  type ProjectPathMode,
} from "../lib/project-form.js";
import { FolderOpenIcon } from "./Icons.js";

/** Form body shared by the dialog and the first-run gate. */
function AddProjectForm({
  showDefaultOption,
  projectsRoot,
  onAdded,
  footer,
}: {
  /** Offer "make default"; the first project becomes the default automatically. */
  showDefaultOption: boolean;
  projectsRoot?: string;
  onAdded: (project: Project) => void;
  /** Renders the action row; gets the submit button so the caller can place it. */
  footer: (submit: ReactNode) => ReactNode;
}) {
  const [form, setForm] = useState<ProjectFormState>(EMPTY_PROJECT_FORM);
  const [makeDefault, setMakeDefault] = useState(!showDefaultOption);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askConfirm, setAskConfirm] = useState(false);
  const patch = (p: Partial<ProjectFormState>) => setForm((f) => ({ ...f, ...p }));

  const browse = async () => {
    if (!desktop) return;
    const title =
      form.mode === "existing"
        ? "Choose the repository folder"
        : "Choose where to create the project";
    const picked = await desktop.pickDirectory(form.directory || undefined, { title });
    if (picked) patch({ directory: picked, confirm: false });
  };

  const issues = projectFormIssues(form);
  const blocked = issues.length > 0 || (askConfirm && !form.confirm);

  const submit = async () => {
    if (issues.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject(toCreateProjectInput(form));
      if (makeDefault) await api.updateSettings({ defaultProject: project.id });
      onAdded(project);
    } catch (err) {
      if (err instanceof ApiError && needsConfirm(err.code)) {
        setAskConfirm(true);
        setError(NOT_EMPTY_NOTICE);
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const label = "flex flex-col gap-1.5 text-sm font-medium";
  return (
    <form
      className="flex flex-col gap-3.5 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={label}>
        Name
        <Input
          autoFocus
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={form.mode === "auto" ? "My project" : "Defaults to the folder name"}
        />
      </label>
      <label className={label}>
        Location
        <NativeSelect
          className="w-full"
          value={form.mode}
          onChange={(e) => {
            setAskConfirm(false);
            patch({ mode: e.target.value as ProjectPathMode, confirm: false });
          }}
        >
          <option value="auto">Create it for me under the projects root</option>
          <option value="new">Create a new folder at a path</option>
          <option value="existing">Use an existing git repository</option>
        </NativeSelect>
      </label>
      {form.mode === "auto" ? (
        <p className="mt-0 mb-3.5 text-ink-muted">
          <bdi>{autoPathHint(projectsRoot, form.name)}</bdi>
        </p>
      ) : (
        <label className={label}>
          Directory
          <span className="flex gap-2">
            <Input
              value={form.directory}
              onChange={(e) => {
                setAskConfirm(false);
                patch({ directory: e.target.value, confirm: false });
              }}
              placeholder="/Users/you/project"
            />
            {desktop && (
              <Button type="button" variant="outline" onClick={() => void browse()}>
                <FolderOpenIcon size={16} /> Browse…
              </Button>
            )}
          </span>
        </label>
      )}
      <label className={label}>
        <span>
          Brief
          {form.mode === "existing" && (
            <span className="font-normal text-muted-foreground"> (optional)</span>
          )}
        </span>
        <Textarea
          value={form.brief}
          onChange={(e) => patch({ brief: e.target.value })}
          placeholder="What is this project and what should the agents know about it?"
        />
      </label>
      {showDefaultOption && (
        <label className="flex flex-row items-center gap-2 text-[length:var(--text-row)]">
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />
          Make this the default project
        </label>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {askConfirm && (
        <label className="flex flex-row items-center gap-2 text-[length:var(--text-row)]">
          <input
            type="checkbox"
            checked={form.confirm}
            onChange={(e) => patch({ confirm: e.target.checked })}
          />
          The folder is not empty. Initialise it anyway.
        </label>
      )}
      {footer(
        <Button type="submit" disabled={busy || blocked}>
          {submitLabel(form.mode, busy)}
        </Button>,
      )}
    </form>
  );
}

export function AddProjectModal({
  open,
  onOpenChange,
  onAdded,
  projectsRoot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (project: Project) => void;
  projectsRoot?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Boof creates the folder and a git repository unless you point it at one.
          </DialogDescription>
        </DialogHeader>
        <AddProjectForm
          showDefaultOption
          projectsRoot={projectsRoot}
          onAdded={onAdded}
          footer={(submit) => (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {submit}
            </DialogFooter>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}

/** First-run gate: shown while there are zero projects. */
export function AddProjectGate({
  onAdded,
  projectsRoot,
}: {
  onAdded: (project: Project) => void;
  projectsRoot?: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[460px] rounded-2xl border border-line bg-surface p-10 text-center shadow-md">
        <img
          className="mx-auto mb-4 size-[72px] rounded-full border border-line shadow-sm"
          src={boofRunnerLogoUrl}
          alt="Boof Runner"
        />
        <h1 className="mt-0 mb-2 text-2xl">Welcome to Boof Runner</h1>
        <p className="mt-0 mb-6 text-[length:var(--text-body)] text-ink-muted">
          Add the first project: Boof Runner can create it for you or use a git repository you
          already have. You can add more projects and switch between them from the header.
        </p>
        <AddProjectForm
          showDefaultOption={false}
          projectsRoot={projectsRoot}
          onAdded={onAdded}
          footer={(submit) => <div className="flex justify-end">{submit}</div>}
        />
      </div>
    </div>
  );
}
