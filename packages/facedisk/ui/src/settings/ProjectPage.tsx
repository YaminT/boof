import { useEffect, useState } from "react";
import type { Project } from "@boof/heart/schema";
import { api } from "../api.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import { Textarea } from "@/ui/textarea";
import { AddProjectModal } from "../components/Projects.js";
import { FolderOpenIcon } from "../components/Icons.js";
import type { AgentSdkEligibility, ProjectView, Whoami } from "../api-types.js";
import { desktop, isDesktop } from "../desktop.js";
import { isApiKeyShape } from "../lib/claude-agent.js";
import { act } from "../lib/act.js";
import type { ProjectPageValues } from "../lib/settings-project.js";
import { ArchivedProjects } from "./ArchivedProjects.js";
import { ClaudeAgentSection } from "./ClaudeAgentSection.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ExternalStepsSection } from "./ExternalStepsSection.js";

import { AdvancedSection } from "./AdvancedSection.js";
const label = "flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium";
const help = "text-[length:var(--text-row)] font-normal text-ink-muted";
const h2 = "m-0 text-[length:var(--text-section)] font-semibold";

/** Settings › Project: this project, the settings about all projects, and archived projects. */
export function ProjectPage({
  dirty,
  form,
  set,
  project,
  projects,
  projectsRoot,
  onProjectAdded,
  reloadProjects,
  advancedOpen,
}: {
  /** Show the advanced sections (expanded view, or the page has unsaved edits). */
  advancedOpen: boolean;
  /** The page has unsaved edits. */
  dirty: boolean;
  form: ProjectPageValues;
  set: (update: (v: ProjectPageValues) => ProjectPageValues) => void;
  project: Project;
  /** Active projects, for the default-project select. */
  projects: Project[];
  projectsRoot: string | undefined;
  onProjectAdded: (p: Project) => void;
  reloadProjects: () => Promise<void>;
}) {
  const [archiving, setArchiving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [eligibility, setEligibility] = useState<AgentSdkEligibility | null>(null);
  const [eligibilityFailed, setEligibilityFailed] = useState(false);
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  useEffect(() => {
    void api
      .whoami()
      .then(setWhoami)
      .catch(() => {});
  }, []);
  // Whether a key is stored; the key itself never reaches the browser.
  const keySet = (project as ProjectView).anthropicApiKeySet === true;
  useEffect(() => {
    setReplacing(false);
  }, [keySet, project.id]);
  useEffect(() => {
    if (isDesktop) return;
    let live = true;
    api
      .agentSdkEligibility()
      .then((e) => live && setEligibility(e))
      .catch(() => live && setEligibilityFailed(true));
    return () => {
      live = false;
    };
  }, []);
  const p = form.project;
  const g = form.global;
  const setP = (patch: Partial<ProjectPageValues["project"]>) =>
    set((v) => ({ ...v, project: { ...v.project, ...patch } }));
  const setG = (patch: Partial<ProjectPageValues["global"]>) =>
    set((v) => ({ ...v, global: { ...v.global, ...patch } }));

  const browse = async () => {
    if (!desktop) return;
    const picked = await desktop.pickDirectory(p.workingDirectory || undefined, {
      title: "Choose the repository folder",
    });
    if (picked) setP({ workingDirectory: picked });
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className={h2}>This project</h2>
        <label className={label}>
          Name
          <Input
            className="mt-0 font-normal"
            value={p.name}
            onChange={(e) => setP({ name: e.target.value })}
          />
        </label>
        <label className={label}>
          Working directory
          <span className="flex gap-2">
            <Input
              className="mt-0 font-mono font-normal"
              value={p.workingDirectory}
              onChange={(e) => setP({ workingDirectory: e.target.value })}
            />
            {desktop && (
              <Button type="button" variant="outline" onClick={() => void browse()}>
                <FolderOpenIcon size={16} /> Browse…
              </Button>
            )}
          </span>
          <span className={help}>Must be a git repository.</span>
        </label>
        <label className={label}>
          Default base branch
          <Input
            className="mt-0 font-normal"
            value={p.defaultBase}
            placeholder="The repository's current branch"
            onChange={(e) => setP({ defaultBase: e.target.value })}
          />
        </label>
        <label className={label}>
          Brief
          <Textarea
            className="mt-0 font-normal"
            rows={6}
            value={p.brief}
            onChange={(e) => setP({ brief: e.target.value })}
          />
          <span className={help}>Given to every agent as the project&apos;s context.</span>
        </label>
        <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-body)] font-normal">
          <input
            type="checkbox"
            checked={p.paused}
            onChange={(e) => setP({ paused: e.target.checked })}
          />
          Paused: the runner skips this project
        </label>
        <div>
          <Button
            type="button"
            variant="outline"
            className="text-failed"
            onClick={() => setArchiving(true)}
          >
            Archive project…
          </Button>
        </div>
      </section>

      <ClaudeAgentSection
        desktop={isDesktop}
        auth={p.claudeAuth}
        onAuth={(claudeAuth) => setP({ claudeAuth })}
        keySet={keySet}
        typedKey={p.anthropicApiKey}
        onTypedKey={(anthropicApiKey) => setP({ anthropicApiKey, removeApiKey: false })}
        replacing={replacing}
        onReplace={() => setReplacing(true)}
        removing={p.removeApiKey}
        onRemove={() => {
          setReplacing(false);
          setP({ removeApiKey: true, anthropicApiKey: "" });
        }}
        onKeep={() => {
          setReplacing(false);
          setP({ removeApiKey: false, anthropicApiKey: "" });
        }}
        problem={
          p.anthropicApiKey.trim() && !isApiKeyShape(p.anthropicApiKey.trim())
            ? "That is not an Anthropic API key. It starts with sk-ant-api."
            : null
        }
        eligibility={eligibility}
        eligibilityFailed={eligibilityFailed}
      />

      <AdvancedSection title="All projects" className="flex flex-col gap-4" open={advancedOpen}>
        <label className={label}>
          Default project
          <NativeSelect
            className="w-full"
            value={g.defaultProject}
            onChange={(e) => setG({ defaultProject: e.target.value })}
          >
            <option value="">None</option>
            {projects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className={label}>
          Projects root
          <Input
            className="mt-0 font-mono font-normal"
            value={g.projectsRoot}
            placeholder={projectsRoot ?? "~/boof-projects"}
            onChange={(e) => setG({ projectsRoot: e.target.value })}
          />
          <span className={help}>
            Where new projects are created when you do not choose a folder; <code>~</code> is the
            server&apos;s home.
          </span>
        </label>
        <div>
          <Button type="button" variant="outline" onClick={() => setAdding(true)}>
            New project…
          </Button>
        </div>
      </AdvancedSection>

      <ExternalStepsSection project={project} whoami={whoami} onSaved={reloadProjects} />

      <ArchivedProjects reloadProjects={reloadProjects} />

      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive project"
        body={`Archive “${project.name}”? It leaves the project list and the runner stops picking up its tasks. Its tasks and files are kept.${dirty ? " Your unsaved changes on this page are lost." : ""}`}
        confirmLabel="Archive project"
        destructive
        onConfirm={async () => {
          const ok = await act(() => api.archiveProject(project.id), {
            success: "Project archived",
            failure: "Could not archive the project",
          });
          if (ok) await reloadProjects();
        }}
      />
      <AddProjectModal
        open={adding}
        onOpenChange={setAdding}
        projectsRoot={projectsRoot}
        onAdded={(x) => {
          setAdding(false);
          onProjectAdded(x);
        }}
      />
    </div>
  );
}
