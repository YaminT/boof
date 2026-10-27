import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { boofRunnerLogoUrl } from "../assets.js";
import type { NavCounts, NavKey } from "./nav.js";

export function NavItem({
  label,
  count,
  active,
  attention,
  onClick,
  className,
}: {
  label: string;
  count?: number;
  active: boolean;
  /** Draw the count in the attention colour. */
  attention?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center justify-between rounded-lg px-2 text-left text-[length:var(--text-body)] transition-colors",
        active ? "bg-accent font-medium text-ink" : "text-ink-muted hover:bg-accent hover:text-ink",
        className,
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "text-[length:var(--text-meta)] tabular-nums",
            attention ? "font-medium text-attention" : "text-ink-muted",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** Left rail for wide screens: project menu, navigation, runner switch and theme. */
export function Rail({
  active,
  counts,
  go,
  projectMenu,
  footer,
}: {
  active: NavKey | null;
  counts: NavCounts;
  go: (key: NavKey) => void;
  projectMenu: ReactNode;
  footer: ReactNode;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-4 border-r border-line bg-surface p-3 min-[720px]:flex">
      <div className="flex items-center gap-2 px-2 pt-1">
        <img src={boofRunnerLogoUrl} alt="" className="size-6 rounded-full" />
        <span className="text-[length:var(--text-body)] font-semibold text-ink">Boof Runner</span>
      </div>
      {projectMenu}
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        <NavItem label="Overview" active={active === "overview"} onClick={() => go("overview")} />
        <NavItem
          label="Tasks"
          count={counts.tasks}
          active={active === "tasks"}
          onClick={() => go("tasks")}
        />
        <NavItem
          label="Plans"
          count={counts.plans}
          active={active === "plans"}
          onClick={() => go("plans")}
        />
        <NavItem label="Settings" active={active === "settings"} onClick={() => go("settings")} />
        <div className="my-2 h-px bg-line" />
        <NavItem
          label="Inbox"
          count={counts.inbox}
          attention
          active={active === "inbox"}
          onClick={() => go("inbox")}
        />
      </nav>
      <div className="mt-auto flex flex-col gap-0.5">{footer}</div>
    </aside>
  );
}
