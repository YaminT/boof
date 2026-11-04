import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";
import { formatRoute, type Route, type SettingsPageId } from "../lib/route.js";

const PAGES: { page: SettingsPageId; label: string }[] = [
  { page: "project", label: "Project" },
  { page: "agents", label: "Agents" },
  { page: "budgets", label: "Budgets" },
  { page: "keys", label: "API keys" },
  { page: "automation", label: "Automation" },
  { page: "accounts", label: "Accounts" },
];

/** Settings pages as tabs; a tab with unsaved edits carries a dot. */
export function SettingsNav({
  pid,
  active,
  unsaved,
}: {
  pid: string;
  active: SettingsPageId;
  unsaved: ReadonlySet<SettingsPageId>;
}) {
  const activeTab = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <nav
      aria-label="Settings"
      className="mb-6 flex gap-4 overflow-x-auto border-b border-line [scrollbar-width:none]"
    >
      {PAGES.map(({ page, label }) => {
        const route: Route = { name: "settings", pid, page };
        const isActive = page === active;
        return (
          <a
            key={page}
            ref={isActive ? activeTab : undefined}
            href={formatRoute(route)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 py-2 text-[length:var(--text-body)] no-underline",
              isActive
                ? "border-accent-brand font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {label}
            {unsaved.has(page) && (
              <>
                <span aria-hidden className="size-1.5 rounded-full bg-accent-brand" />
                <span className="sr-only"> (unsaved changes)</span>
              </>
            )}
          </a>
        );
      })}
    </nav>
  );
}
