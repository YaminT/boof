import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Settings } from "@boof-runner/shared/schema";
import type { SettingsPageId } from "../lib/route.js";
import { NEEDS_SETTINGS_READ, settingsPageAccess } from "../lib/settings-access.js";
import { projectPage } from "../lib/settings-project.js";
import { agentsPage } from "../lib/settings-agents.js";
import { budgetsPage } from "../lib/settings-budgets.js";
import type { AppData } from "../useAppData.js";
import { AgentsPage } from "./AgentsPage.js";
import { AutomationPage } from "./AutomationPage.js";
import { BudgetsPage } from "./BudgetsPage.js";
import { KeysPage } from "./KeysPage.js";
import { setLeaveGuard, staysInSettings } from "../lib/leave-guard.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ProjectPage } from "./ProjectPage.js";
import { SettingsFooter } from "./SettingsFooter.js";
import { SettingsNav } from "./SettingsNav.js";
import { useSettingsPage } from "./useSettingsPage.js";

/**
 * Every settings route of one project. It holds each form page's draft, so moving between pages
 * keeps unsaved edits, and it warns before the browser tab is left with edits pending.
 */
function SettingsForms({
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
  const budgets = useSettingsPage(budgetsPage, settings, project, pid, onSaved);

  const unsaved = useMemo(() => {
    const s = new Set<SettingsPageId>();
    if (proj.dirty) s.add("project");
    if (agents.dirty) s.add("agents");
    if (budgets.dirty) s.add("budgets");
    return s;
  }, [proj.dirty, agents.dirty, budgets.dirty]);

  // In-app navigation away from the settings (another screen, another project) asks first.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = unsaved.size > 0;
  useEffect(() => {
    setLeaveGuard((to, proceed) => {
      if (!dirtyRef.current || staysInSettings(to, pid)) return false;
      setLeaving(() => proceed);
      return true;
    });
    return () => setLeaveGuard(null);
  }, [pid]);

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
      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(o) => !o && setLeaving(null)}
        title="Discard unsaved changes?"
        body="You have unsaved changes on these settings pages. Leaving now discards them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          const go = leaving;
          setLeaving(null);
          go?.();
        }}
      />
      <h1 className="m-0 mb-4 text-[length:var(--text-page)] leading-tight font-semibold">
        Settings
      </h1>
      <SettingsNav pid={pid} active={page} unsaved={unsaved} />
      {page === "project" && (
        <>
          <ProjectPage
            dirty={proj.dirty}
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
        <>
          <BudgetsPage
            form={budgets.form}
            set={budgets.set}
            project={project}
            budget={data.budget}
          />
          <SettingsFooter
            dirty={budgets.dirty}
            elsewhere={budgets.elsewhere}
            busy={budgets.busy}
            problems={budgets.problems}
            savedAt={budgets.savedAt}
            onSave={() => void budgets.save()}
            onReload={budgets.reload}
          />
        </>
      )}
      {page === "keys" && <KeysPage projects={projects} />}
      {page === "automation" && <AutomationPage projects={projects} onChange={data.refresh} />}
    </div>
  );
}

/**
 * The settings area of one project. With the settings loaded it holds the form drafts; without
 * them (a key lacking `settings:read`) it still shows the frame and the pages that load their own
 * data, and says what the others need.
 */
export function SettingsScreen(props: {
  pid: string;
  page: SettingsPageId;
  settings: Settings | null;
  project: Project;
  projects: Project[];
  data: AppData;
  onProjectAdded: (p: Project) => void;
  reloadProjects: () => Promise<void>;
}) {
  const { settings, ...rest } = props;
  if (settings) return <SettingsForms settings={settings} {...rest} />;
  const access = settingsPageAccess(props.page, false);
  return (
    <div className="flex max-w-[1320px] flex-col">
      <h1 className="m-0 mb-4 text-[length:var(--text-page)] leading-tight font-semibold">
        Settings
      </h1>
      <SettingsNav pid={props.pid} active={props.page} unsaved={new Set()} />
      {access === "needs-settings-read" ? (
        <p className="m-0 text-[length:var(--text-body)] text-attention">{NEEDS_SETTINGS_READ}</p>
      ) : props.page === "keys" ? (
        <KeysPage projects={props.projects} />
      ) : (
        <AutomationPage projects={props.projects} onChange={props.data.refresh} />
      )}
    </div>
  );
}
