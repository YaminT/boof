import { useEffect } from "react";
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
import { isMacUserAgent, isPaletteShortcut } from "../lib/palette-shortcut.js";
import type { ActionGroup, CommandAction } from "../lib/command-actions.js";

const GROUP_ORDER: ActionGroup[] = ["Go to", "Projects", "Tasks", "Actions"];

export function isMac(): boolean {
  return typeof navigator !== "undefined" && isMacUserAgent(navigator.userAgent || "");
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
  actions,
  open,
  onOpenChange,
}: {
  /** The shared actions, wired in `useCommandActions`; the caller renders the stop dialog. */
  actions: CommandAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  usePaletteShortcut(open, onOpenChange);

  const select = (action: CommandAction) => () => {
    onOpenChange(false);
    // Failures are already toasts; a dismissed stop confirmation is not an error here.
    void Promise.resolve(action.run()).catch(() => undefined);
  };
  const groups = GROUP_ORDER.map((g) => ({
    g,
    items: actions.filter((a) => a.group === g),
  })).filter((x) => x.items.length > 0);

  return (
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
