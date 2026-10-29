import { useEffect, useState, type ReactNode } from "react";
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
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";
import type { TaskView } from "../api.js";
import type { AppData } from "../useAppData.js";
import type { Route, SettingsPageId } from "../lib/route.js";
import { isPaletteShortcut } from "../lib/palette-shortcut.js";
import { act } from "../lib/act.js";
import { api } from "../api.js";
import { groupTasks } from "../lib/task-groups.js";
import { statusLabel } from "../lib/status.js";
import { useTheme, type ThemePref } from "../lib/theme.js";
import { toggleRunner } from "./RunnerSwitch.js";

const SETTINGS_PAGES: { page: SettingsPageId; label: string }[] = [
  { page: "project", label: "Project settings" },
  { page: "agents", label: "Agent settings" },
  { page: "budgets", label: "Budget settings" },
  { page: "keys", label: "Key settings" },
  { page: "automation", label: "Automation settings" },
];

const THEMES: { pref: ThemePref; label: string }[] = [
  { pref: "light", label: "Use light theme" },
  { pref: "dark", label: "Use dark theme" },
  { pref: "system", label: "Use system theme" },
];

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
  open,
  onOpenChange,
}: {
  data: AppData;
  projects: Project[] | null;
  /** The selected project, or null before one is chosen. */
  currentPid: string | null;
  navigate: (to: Route) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { setPref } = useTheme();
  const [stopping, setStopping] = useState<TaskView | null>(null);
  usePaletteShortcut(open, onOpenChange);

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const go = (to: Route) => run(() => navigate(to));
  const pid = currentPid;
  const enabled = data.settings?.runner.enabled ?? false;
  const otherProjects = (projects ?? []).filter((p) => !p.archived);

  const groups = groupTasks(data.tasks, data.plans);
  const proposedIds = new Set(
    groups.needsYou.flatMap((n) => (n.kind === "proposed" ? [n.task.frontmatter.id] : [])),
  );
  const draftPlans = groups.needsYou.flatMap((n) => (n.kind === "draft-plan" ? [n.plan] : []));
  const queueable = data.tasks.filter((t) => t.frontmatter.status === "draft");
  const mutate = (fn: () => Promise<unknown>, success: string, failure: string) =>
    run(() => {
      void act(fn, { success, failure }).then(() => data.refresh());
    });

  const item = (key: string, label: string, onSelect: () => void, extra?: ReactNode) => (
    <CommandItem key={key} value={label} onSelect={onSelect}>
      {label}
      {extra}
    </CommandItem>
  );

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Search"
        description="Go to a page, switch project, open a task or run an action."
      >
        <Command className="**:data-[selected=true]:bg-accent! **:data-[selected=false]:bg-transparent!">
          <CommandInput
            className="m-0! rounded-none! border-0! bg-transparent! py-0! pr-0! pl-2! shadow-none! outline-none!"
            placeholder="Search pages, tasks and actions"
          />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup heading="Go to">
              {item("inbox", "Go to Inbox", go({ name: "inbox" }))}
              {pid && (
                <>
                  {item("overview", "Go to Overview", go({ name: "overview", pid }))}
                  {item("tasks", "Go to Tasks", go({ name: "tasks", pid }))}
                  {item("plans", "Go to Plans", go({ name: "plans", pid }))}
                  {item(
                    "settings",
                    "Go to Settings",
                    go({ name: "settings", pid, page: "project" }),
                  )}
                  {SETTINGS_PAGES.map(({ page, label }) =>
                    item(`settings-${page}`, `Go to ${label}`, go({ name: "settings", pid, page })),
                  )}
                </>
              )}
            </CommandGroup>
            {otherProjects.length > 0 && (
              <CommandGroup heading="Projects">
                {otherProjects.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`Switch to project ${p.name}`}
                    onSelect={go({ name: "overview", pid: p.id })}
                  >
                    Switch to {p.name}
                    {p.id === pid && (
                      <span className="ml-auto text-[length:var(--text-meta)] text-ink-muted">
                        current
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {pid && data.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {data.tasks.map((t) => (
                  <CommandItem
                    key={t.frontmatter.id}
                    value={`Open task ${t.frontmatter.title} ${t.frontmatter.id}`}
                    onSelect={go({ name: "task", pid, taskId: t.frontmatter.id, view: "edit" })}
                  >
                    <span className="truncate">{t.frontmatter.title}</span>
                    <span className="ml-auto shrink-0 text-[length:var(--text-meta)] text-ink-muted">
                      {statusLabel(t.frontmatter.status)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Actions">
              {pid &&
                item(
                  "new-task",
                  "New task",
                  go({ name: "task", pid, taskId: "__new__", view: "edit" }),
                )}
              {pid &&
                draftPlans.map((p) => (
                  <CommandItem
                    key={`activate-${p.id}`}
                    value={`Activate plan: ${p.title} ${p.id}`}
                    keywords={["activate", "plan"]}
                    onSelect={mutate(
                      () => api.updatePlan(pid, p, { status: "active" }),
                      "Plan activated",
                      "Could not activate",
                    )}
                  >
                    Activate plan: {p.title}
                  </CommandItem>
                ))}
              {pid &&
                queueable.map((t) => {
                  const proposed = proposedIds.has(t.frontmatter.id);
                  const label = `${proposed ? "Queue proposed task" : "Queue"}: ${t.frontmatter.title}`;
                  return (
                    <CommandItem
                      key={`queue-${t.frontmatter.id}`}
                      value={`${label} ${t.frontmatter.id}`}
                      keywords={["queue", "task"]}
                      onSelect={mutate(
                        () => api.updateTask(pid, t.frontmatter.id, { status: "pending" }),
                        "Queued",
                        "Could not queue",
                      )}
                    >
                      {label}
                    </CommandItem>
                  );
                })}
              {pid &&
                groups.running.map((t) => (
                  <CommandItem
                    key={`stop-${t.frontmatter.id}`}
                    value={`Stop: ${t.frontmatter.title} ${t.frontmatter.id}`}
                    keywords={["stop", "task"]}
                    onSelect={run(() => setStopping(t))}
                  >
                    Stop: {t.frontmatter.title}
                  </CommandItem>
                ))}
              <CommandItem
                value={enabled ? "Pause the runner" : "Start the runner"}
                disabled={!data.settings}
                onSelect={run(() => {
                  void toggleRunner(enabled).then(() => data.refresh());
                })}
              >
                {enabled ? "Pause the runner" : "Start the runner"}
              </CommandItem>
              {THEMES.map(({ pref, label }) =>
                item(
                  `theme-${pref}`,
                  label,
                  run(() => setPref(pref)),
                ),
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <Dialog open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Stop task</DialogTitle>
            <DialogDescription>
              Stop this task? The agent stops and the task moves to stopped. Its worktree is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-transparent!">
            <Button variant="outline" onClick={() => setStopping(null)}>
              Keep running
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const t = stopping;
                setStopping(null);
                if (!t || !pid) return;
                void act(() => api.stopTask(pid, t.frontmatter.id), {
                  success: "Stop requested",
                  failure: "Could not stop",
                }).then(() => data.refresh());
              }}
            >
              Stop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      {withShortcut && (
        <Kbd className="border border-line bg-page text-ink-muted">{paletteShortcutLabel()}</Kbd>
      )}
    </button>
  );
}
