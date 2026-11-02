import { useEffect, useMemo } from "react";
import type { Project, Settings } from "@boof-runner/shared/schema";
import { SettingsPage } from "../components/SettingsPage.js";
import { ClientsSection } from "../components/ClientsSection.js";
import { CommandsTab } from "../components/CommandsTab.js";
import type { SettingsPageId } from "../lib/route.js";
import { projectPage } from "../lib/settings-project.js";
import { agentsPage } from "../lib/settings-agents.js";
import type { AppData } from "../useAppData.js";
import { AgentsPage } from "./AgentsPage.js";
import { ProjectPage } from "./ProjectPage.js";
import { SettingsFooter } from "./SettingsFooter.js";
import { SettingsNav } from "./SettingsNav.js";
import { useSettingsPage } from "./useSettingsPage.js";

/**
 * Every settings route of one project. It holds each form page's draft, so moving between pages
 * keeps unsaved edits, and it warns before the browser tab is left with edits pending.
 */
export function SettingsScreen({
  pid,
  page,
  settings,
  project,
  projects,
  data,
  onProjectAdded,
  reloadProjects,
}: {
  pid: string;
  page: SettingsPageId;
  settings: Settings;
  project: Project;
  /** Active projects. */
  projects: Project[];
  data: AppData;
  onProjectAdded: (p: Project) => void;
  reloadProjects: () => Promise<void>;
}) {
  const onSaved = useMemo(() => () => data.refresh(), [data]);
  const proj = useSettingsPage(projectPage, settings, project, pid, onSaved);
  const agents = useSettingsPage(agentsPage, settings, project, pid, onSaved);

  const unsaved = useMemo(() => {
    const s = new Set<SettingsPageId>();
    if (proj.dirty) s.add("project");
    if (agents.dirty) s.add("agents");
    return s;
  }, [proj.dirty, agents.dirty]);

  useEffect(() => {
    if (unsaved.size === 0) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [unsaved]);

  return (
    <div className="flex max-w-[1320px] flex-col">
      <h1 className="m-0 mb-4 text-[length:var(--text-page)] leading-tight font-semibold">
        Settings
      </h1>
      <SettingsNav pid={pid} active={page} unsaved={unsaved} />
      {page === "project" && (
        <>
          <ProjectPage
            form={proj.form}
            set={proj.set}
            project={project}
            projects={projects}
            projectsRoot={settings.projectsRoot}
            onProjectAdded={onProjectAdded}
            reloadProjects={reloadProjects}
          />
          <SettingsFooter
            dirty={proj.dirty}
            elsewhere={proj.elsewhere}
            busy={proj.busy}
            problems={proj.problems}
            savedAt={proj.savedAt}
            onSave={() => void proj.save()}
            onReload={proj.reload}
          />
        </>
      )}
      {page === "agents" && (
        <>
          <AgentsPage form={agents.form} set={agents.set} project={project} />
          <SettingsFooter
            dirty={agents.dirty}
            elsewhere={agents.elsewhere}
            busy={agents.busy}
            problems={agents.problems}
            savedAt={agents.savedAt}
            onSave={() => void agents.save()}
            onReload={agents.reload}
          />
        </>
      )}
      {page === "budgets" && (
        <SettingsPage
          settings={settings}
          projects={projects}
          project={project}
          onChange={data.refresh}
        />
      )}
      {page === "keys" && <ClientsSection />}
      {page === "automation" && <CommandsTab onChange={data.refresh} />}
    </div>
  );
}
