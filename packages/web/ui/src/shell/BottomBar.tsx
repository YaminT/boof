import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";
import { NavItem } from "./Rail.js";
import type { NavCounts, NavKey } from "./nav.js";

/** Fixed tab bar below 720 px; More opens a sheet with the rest of the shell. */
export function BottomBar({
  active,
  counts,
  go,
  moreContent,
}: {
  active: NavKey | null;
  counts: NavCounts;
  go: (key: NavKey) => void;
  /** Project menu, runner switch and theme menu. */
  moreContent: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tabs: { key: NavKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "tasks", label: "Tasks" },
    { key: "plans", label: "Plans" },
  ];
  const moreActive = active === "inbox" || active === "settings";
  const tabClass = (on: boolean) =>
    cn(
      "flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[length:var(--text-meta)]",
      on ? "font-medium text-accent-brand" : "text-ink-muted",
    );
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] min-[720px]:hidden"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tabClass(active === t.key)}
            aria-current={active === t.key ? "page" : undefined}
            onClick={() => go(t.key)}
          >
            {t.key === "tasks" && counts.tasks > 0 ? `${t.label} (${counts.tasks})` : t.label}
          </button>
        ))}
        <button type="button" className={tabClass(moreActive)} onClick={() => setOpen(true)}>
          More
          {counts.inbox > 0 && (
            <span className="font-medium text-attention">{counts.inbox} in inbox</span>
          )}
        </button>
      </nav>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="gap-2 p-3 pb-6">
          <SheetHeader className="p-0 px-2">
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <NavItem
            label="Inbox"
            count={counts.inbox}
            attention
            active={active === "inbox"}
            onClick={() => {
              setOpen(false);
              go("inbox");
            }}
          />
          <NavItem
            label="Settings"
            active={active === "settings"}
            onClick={() => {
              setOpen(false);
              go("settings");
            }}
          />
          <div className="my-1 h-px bg-line" />
          {moreContent}
        </SheetContent>
      </Sheet>
    </>
  );
}
