import type { ReactNode } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { TooltipProvider } from "@/ui/tooltip";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { BottomBar } from "./BottomBar.js";
import { ProjectMenu } from "./ProjectMenu.js";
import { Rail } from "./Rail.js";
import { RunnerSwitch } from "./RunnerSwitch.js";
import { ThemeMenu } from "./ThemeMenu.js";
import { navKey, type NavCounts, type NavKey } from "./nav.js";

const OPEN_STATUSES = new Set(["draft", "pending", "running", "action"]);

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
  const pid = selected?.id ?? null;
  const counts: NavCounts = {
    tasks: data.tasks.filter((t) => OPEN_STATUSES.has(t.frontmatter.status)).length,
    plans: data.plans.length,
    inbox: data.actions.length,
  };

  const go = (key: NavKey) => {
    if (key === "inbox") return navigate({ name: "inbox" });
    if (!pid) return;
    if (key === "settings") return navigate({ name: "settings", pid, page: "project" });
    navigate({ name: key, pid });
  };

  const projectMenu = (
    <ProjectMenu
      projects={projects}
      selected={selected}
      onSelect={onSelectProject}
      onAdded={onProjectAdded}
    />
  );
  const runner = <RunnerSwitch settings={data.settings} onChange={() => data.refresh()} />;

  return (
    <TooltipProvider>
      <div className="flex min-h-screen bg-page font-sans text-ink">
        <Rail
          active={navKey(route)}
          counts={counts}
          go={go}
          projectMenu={projectMenu}
          footer={
            <>
              {runner}
              <ThemeMenu />
            </>
          }
        />
        <div className="min-w-0 flex-1 px-4 pb-24 min-[720px]:px-8 min-[720px]:pb-12">
          <main className="mx-auto w-full max-w-[1320px]">{children}</main>
        </div>
        <BottomBar
          active={navKey(route)}
          counts={counts}
          go={go}
          moreContent={
            <>
              {projectMenu}
              {runner}
              <ThemeMenu />
            </>
          }
        />
      </div>
    </TooltipProvider>
  );
}
