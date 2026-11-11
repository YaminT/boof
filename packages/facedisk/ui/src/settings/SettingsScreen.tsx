import { FocusToggle } from "@/ui/focus-toggle";
import { useFocusMode } from "../lib/useFocusMode.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Settings } from "@boof/heart/schema";
import type { SettingsPageId } from "../lib/route.js";
import {
  NEEDS_PROJECTS_READ,
  NEEDS_SETTINGS_READ,
  settingsPageAccess,
} from "../lib/settings-access.js";
import { api } from "../api.js";
import { isDesktop } from "../desktop.js";
import { act } from "../lib/act.js";
import { makeProjectPage } from "../lib/settings-project.js";
import { makeAgentsPage } from "../lib/settings-agents.js";
import { budgetsPage } from "../lib/settings-budgets.js";
import type { AppData } from "../useAppData.js";
import { AgentsPage } from "./AgentsPage.js";
import { SandboxSection } from "./SandboxSection.js";
import { AutomationPage } from "./AutomationPage.js";
import { BudgetsPage } from "./BudgetsPage.js";
import { KeysPage } from "./KeysPage.js";
import { setLeaveGuard, staysInSettings } from "../lib/leave-guard.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ProjectPage } from "./ProjectPage.js";
import { SettingsFooter } from "./SettingsFooter.js";
import { SettingsNav } from "./SettingsNav.js";
import { useSettingsPage } from "./useSettingsPage.js";
import { AccountsPage } from "./AccountsPage.js";
import { accountsPage } from "../lib/settings-accounts.js";

/** The desktop app has no Claude Agent SDK: its project page makes no claudeAgent or key patch. */
const projectPage = makeProjectPage({ isDesktop });

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
  const focus = useFocusMode("settings");
  // Tools the API lists as unavailable (the Agents page reports them once it has loaded them).
  const [unavailable, setUnavailable] = useState<Record<string, string>>({});
  const agentsModel = useMemo(() => makeAgentsPage({ isDesktop, unavailable }), [unavailable]);
  const proj = useSettingsPage(projectPage, settings, project, pid, onSaved);
  const agents = useSettingsPage(agentsModel, settings, project, pid, onSaved);
  const budgets = useSettingsPage(budgetsPage, settings, project, pid, onSaved);
  const accounts = useSettingsPage(accountsPage, settings, project, pid, onSaved);

  const unsaved = useMemo(() => {
    const s = new Set<SettingsPageId>();
    if (proj.dirty) s.add("project");
    if (agents.dirty) s.add("agents");
    if (budgets.dirty) s.add("budgets");
    if (accounts.dirty) s.add("accounts");
    return s;
  }, [proj.dirty, agents.dirty, budgets.dirty, accounts.dirty]);

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
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="m-0 flex-1 text-[length:var(--text-page)] leading-tight font-semibold">
          Settings
        </h1>
        {!(["budgets", "keys", "automation"] as SettingsPageId[]).includes(page) && (
          <FocusToggle mode={focus.mode} onToggle={focus.toggle} />
        )}
      </div>
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
            advancedOpen={focus.expanded || proj.dirty}
            updatesCheck={settings.updates?.check !== false}
            onUpdatesCheck={(check) => {
              void act(
                async () => {
                  await api.updateSettings({ updates: { check } });
                  await data.refresh();
                },
                { failure: "Could not save the update check" },
              );
            }}
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
          <AgentsPage
            form={agents.form}
            set={agents.set}
            project={project}
            advancedOpen={focus.expanded || agents.dirty}
            onUnavailable={setUnavailable}
          />
          <SandboxSection sandbox={settings.runner.sandbox} onSaved={onSaved} />
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
      {page === "accounts" && (
        <>
          <AccountsPage
            settings={settings}
            onChanged={onSaved}
            advancedOpen={focus.expanded}
            form={accounts.form.global}
            setForm={(update) => accounts.set((v) => ({ ...v, global: update(v.global) }))}
          />
          <SettingsFooter
            dirty={accounts.dirty}
            elsewhere={accounts.elsewhere}
            busy={accounts.busy}
            problems={accounts.problems}
            savedAt={accounts.savedAt}
            onSave={() => void accounts.save()}
            onReload={accounts.reload}
          />
        </>
      )}
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
  project: Project | null;
  projects: Project[];
  data: AppData;
  onProjectAdded: (p: Project) => void;
  reloadProjects: () => Promise<void>;
}) {
  const { settings, project, ...rest } = props;
  if (settings && project) return <SettingsForms settings={settings} project={project} {...rest} />;
  const access = settingsPageAccess(props.page, { settings: !!settings, project: !!project });
  return (
    <div className="flex max-w-[1320px] flex-col">
      <h1 className="m-0 mb-4 text-[length:var(--text-page)] leading-tight font-semibold">
        Settings
      </h1>
      <SettingsNav pid={props.pid} active={props.page} unsaved={new Set()} />
      {access === "needs-projects-read" || access === "needs-settings-read" ? (
        <p className="m-0 text-[length:var(--text-body)] text-attention">
          {access === "needs-projects-read" ? NEEDS_PROJECTS_READ : NEEDS_SETTINGS_READ}
        </p>
      ) : props.page === "keys" ? (
        <KeysPage projects={props.projects} />
      ) : props.page === "accounts" ? (
        <AccountsPage
          settings={{} as Settings}
          onChanged={props.data.refresh}
          advancedOpen={false}
          form={{ enabled: false, url: "http://127.0.0.1:8080", healthGate: "pause" }}
          setForm={() => {}}
        />
      ) : (
        <AutomationPage projects={props.projects} onChange={props.data.refresh} />
      )}
    </div>
  );
}
