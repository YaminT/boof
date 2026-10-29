import { cn } from "@/lib/utils";
import { formatRoute, type Route, type SettingsPageId } from "../lib/route.js";

const PAGES: { page: SettingsPageId; label: string }[] = [
  { page: "project", label: "Project" },
  { page: "automation", label: "Automation" },
];

/** Links between the settings pages that exist as screens; phase 5 replaces it with the split. */
export function SettingsNav({ pid, active }: { pid: string; active: SettingsPageId }) {
  const current = active === "automation" ? "automation" : "project";
  return (
    <nav aria-label="Settings" className="mb-4 flex gap-4 border-b border-line">
      {PAGES.map(({ page, label }) => {
        const route: Route = { name: "settings", pid, page };
        const isActive = page === current;
        return (
          <a
            key={page}
            href={formatRoute(route)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 py-2 text-[length:var(--text-body)] no-underline",
              isActive
                ? "border-accent-brand font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
