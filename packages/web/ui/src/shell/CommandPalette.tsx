import { useEffect, useState } from "react";
import type { Project } from "@boof-runner/shared/schema";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/command";
import { Kbd } from "@/ui/kbd";
import { StopTaskDialog } from "./StopTaskDialog.js";
import type { TaskView } from "../api.js";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { isPaletteShortcut } from "../lib/palette-shortcut.js";
import { act } from "../lib/act.js";
import { api } from "../api.js";
import {
  createCommandActions,
  type ActionGroup,
  type CommandAction,
} from "../lib/command-actions.js";
import { useTheme } from "../lib/theme.js";
import { toggleRunner } from "./RunnerSwitch.js";

const GROUP_ORDER: ActionGroup[] = ["Go to", "Projects", "Tasks", "Actions"];

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The shortcut as shown to the user: "⌘K" on macOS, "Ctrl K" elsewhere. */
export function paletteShortcutLabel(): string {
  return isMac() ? "⌘K" : "Ctrl K";
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** Opens the palette on Ctrl+K (⌘K on macOS) unless focus is in a field outside the palette. */
export function usePaletteShortcut(open: boolean, onOpenChange: (open: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const editableOutside = isEditable(target) && !target?.closest("[cmdk-root]");
      if (!isPaletteShortcut(e, isMac(), editableOutside)) return;
      e.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
}

export function CommandPalette({
  data,
  projects,
  currentPid,
  navigate,
  onSelectProject,
  open,
  onOpenChange,
}: {
  data: AppData;
  projects: Project[] | null;
  /** The selected project, or null before one is chosen. */
  currentPid: string | null;
  navigate: (to: Route) => void;
  /** Switch project to the equivalent screen (same as the project menu). */
  onSelectProject: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { setPref } = useTheme();
  const [stopping, setStopping] = useState<TaskView | null>(null);
  usePaletteShortcut(open, onOpenChange);

  const pid = currentPid;
  const mutate = (fn: () => Promise<unknown>, success: string, failure: string) =>
    act(fn, { success, failure }).then(() => data.refresh());

  const actions = createCommandActions({
    pid,
    projects: projects ?? [],
    tasks: data.tasks,
    plans: data.plans,
    runnerEnabled: data.settings?.runner.enabled ?? false,
    settingsLoaded: !!data.settings,
    effects: {
      navigate,
      selectProject: onSelectProject,
      setTheme: setPref,
      requestStop: setStopping,
      activatePlan: (id, plan) =>
        mutate(
          () => api.updatePlan(id, plan, { status: "active" }),
          "Plan activated",
          "Could not activate",
        ),
      queueTask: (id, taskId) =>
        mutate(
          () => api.updateTask(id, taskId, { status: "pending" }),
          "Queued",
          "Could not queue",
        ),
      setRunner: (enabled) => toggleRunner(enabled).then(() => data.refresh()),
    },
  });

  const select = (action: CommandAction) => () => {
    onOpenChange(false);
    void action.run();
  };
  const groups = GROUP_ORDER.map((g) => ({
    g,
    items: actions.filter((a) => a.group === g),
  })).filter((x) => x.items.length > 0);

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Search"
        description="Go to a page, switch project, open a task or run an action."
      >
        <Command>
          <CommandInput placeholder="Search pages, tasks and actions" />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {groups.map(({ g, items }) => (
              <CommandGroup key={g} heading={g}>
                {items.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={a.searchValue}
                    keywords={a.keywords}
                    disabled={a.disabled}
                    onSelect={select(a)}
                  >
                    <span className={a.meta ? "truncate" : undefined}>{a.label}</span>
                    {a.meta && (
                      <span className="ml-auto shrink-0 text-[length:var(--text-meta)] text-ink-muted">
                        {a.meta}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
      <StopTaskDialog
        open={stopping !== null}
        onOpenChange={(o) => !o && setStopping(null)}
        onConfirm={() => {
          const t = stopping;
          setStopping(null);
          if (!t || !pid) return;
          void act(() => api.stopTask(pid, t.frontmatter.id), {
            success: "Stop requested",
            failure: "Could not stop",
          }).then(() => data.refresh());
        }}
      />
    </>
  );
}

/** Rail and More-sheet entry that opens the palette. */
export function SearchButton({
  onClick,
  withShortcut,
}: {
  onClick: () => void;
  withShortcut?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-[length:var(--text-body)] text-ink-muted transition-colors hover:bg-accent hover:text-ink"
    >
      Search
      {withShortcut && <Kbd>{paletteShortcutLabel()}</Kbd>}
    </button>
  );
}
