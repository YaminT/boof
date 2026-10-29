import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import type { Project } from "@boof-runner/shared/schema";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

/** Current project name; opens a list of projects with their working directories. */
export function ProjectMenu({
  projects,
  selected,
  onSelect,
  onAddProject,
}: {
  projects: Project[] | null;
  selected: Project | null;
  onSelect: (id: string) => void;
  onAddProject: () => void;
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Switch project"
          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-[length:var(--text-body)] font-semibold text-ink hover:bg-accent"
        >
          <span className="truncate">{selected?.name ?? "Projects"}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-ink-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {(projects ?? [])
            .filter((p) => !p.archived)
            .map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => onSelect(p.id)}
                className="flex-col items-start gap-0.5"
              >
                <span className="text-[length:var(--text-row)] font-medium">
                  {p.name}
                  {p.paused ? " (paused)" : ""}
                  {p.id === selected?.id ? " (current)" : ""}
                </span>
                <span className="w-full truncate font-mono text-[length:var(--text-meta)] text-ink-muted">
                  <bdi>{p.workingDirectory}</bdi>
                </span>
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onAddProject}>
            <PlusIcon className="size-4" />
            Add project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
