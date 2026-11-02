import { useState, type ReactNode } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { TooltipProvider } from "@/ui/tooltip";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { AddProjectModal } from "../components/Projects.js";
import { CommandConsole } from "./CommandConsole.js";
import { CommandPalette, SearchButton } from "./CommandPalette.js";
import { useCommandActions } from "./useCommandActions.js";
import { BottomBar } from "./BottomBar.js";
import { ProjectMenu } from "./ProjectMenu.js";
import { Rail } from "./Rail.js";
import { RunnerSwitch } from "./RunnerSwitch.js";
import { ThemeMenu } from "./ThemeMenu.js";
import { inboxCount, inboxGroups } from "../lib/inbox.js";
import { groupTasks } from "../lib/task-groups.js";
import { navKey, type NavCounts, type NavKey } from "./nav.js";

const OPEN_STATUSES = new Set(["draft", "pending", "running", "action"]);

/**
 * On narrow screens the project menu lives in the "More" sheet, which closes when the dialog
 * opens, so the dialog has nothing to return focus to: hand it to the More button instead.
 */
function restoreMoreFocus() {
  window.setTimeout(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const more = document.querySelector<HTMLElement>("[data-more-trigger]");
    if (more && more.offsetParent !== null) more.focus();
  }, 100);
}

export function AppShell({
  data,
  projects,
  selected,
  route,
  navigate,
  onSelectProject,
  onProjectAdded,
  children,
}: {
  data: AppData;
  projects: Project[] | null;
  selected: Project | null;
  route: Route | null;
  navigate: (to: Route, opts?: { replace?: boolean }) => void;
  onSelectProject: (id: string) => void;
  onProjectAdded: (project: Project) => void;
  children: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [searching, setSearching] = useState(false);
  const pid = selected?.id ?? null;
  const palette = useCommandActions({
    data,
    projects,
    pid,
    navigate,
    onSelectProject,
    mode: "toast",
  });
  const consoleActions = useCommandActions({
    data,
    projects,
    pid,
    navigate,
    onSelectProject,
    mode: "throw",
  });
  const counts: NavCounts = {
    tasks: data.tasks.filter((t) => OPEN_STATUSES.has(t.frontmatter.status)).length,
    plans: data.plans.length,
    inbox: inboxCount(
      inboxGroups(
        data.actions,
        selected
          ? { pid: selected.id, needsYou: groupTasks(data.tasks, data.plans).needsYou }
          : null,
        projects ?? [],
      ),
    ),
  };

  const go = (key: NavKey) => {
    if (key === "inbox") return navigate({ name: "inbox" });
    if (!pid) return;
    if (key === "settings") return navigate({ name: "settings", pid, page: "project" });
    navigate({ name: key, pid });
  };

  // `close` shuts the More sheet before an action in it runs; the rail passes nothing.
  const projectMenu = (close?: () => void) => (
    <ProjectMenu
      projects={projects}
      selected={selected}
      onSelect={(id) => {
        close?.();
        onSelectProject(id);
      }}
      onAddProject={() => {
        close?.();
        setAdding(true);
      }}
    />
  );
  const runner = (close?: () => void) => (
    <RunnerSwitch settings={data.settings} onChange={() => data.refresh()} onToggled={close} />
  );

  return (
    <TooltipProvider>
      <div className="flex min-h-screen bg-page font-sans text-ink">
        <Rail
          active={navKey(route)}
          counts={counts}
          go={go}
          projectMenu={projectMenu()}
          footer={
            <>
              <SearchButton onClick={() => setSearching(true)} withShortcut />
              {runner()}
              <ThemeMenu />
            </>
          }
        />
        <div className="flex min-w-0 flex-1 flex-col px-4 min-[720px]:px-8">
          <main className="mx-auto w-full max-w-[1320px] flex-1 pb-8 min-[720px]:pb-12">
            {children}
          </main>
          <CommandConsole actions={consoleActions.actions} />
        </div>
        <BottomBar
          active={navKey(route)}
          counts={counts}
          go={go}
          moreContent={(close) => (
            <>
              <SearchButton
                onClick={() => {
                  close();
                  setSearching(true);
                }}
              />
              {projectMenu(close)}
              {runner(close)}
              <ThemeMenu onPicked={close} />
            </>
          )}
        />
        <CommandPalette actions={palette.actions} open={searching} onOpenChange={setSearching} />
        {palette.stopDialog}
        {consoleActions.stopDialog}
        <AddProjectModal
          open={adding}
          onOpenChange={(open) => {
            setAdding(open);
            if (!open) restoreMoreFocus();
          }}
          projectsRoot={data.settings?.projectsRoot}
          onAdded={(p) => {
            setAdding(false);
            onProjectAdded(p);
          }}
        />
      </div>
    </TooltipProvider>
  );
}
