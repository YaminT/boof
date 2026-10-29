import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme, type ThemePref } from "../lib/theme.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

const LABEL: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };

export function ThemeMenu({ onPicked }: { onPicked?: () => void }) {
  const { pref, setPref } = useTheme();
  const Icon = pref === "light" ? SunIcon : pref === "dark" ? MoonIcon : MonitorIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-[length:var(--text-row)] text-ink hover:bg-accent"
        aria-label="Theme"
      >
        <Icon className="size-4 text-ink-muted" />
        Theme: {LABEL[pref]}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-40">
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(v) => {
            setPref(v as ThemePref);
            onPicked?.();
          }}
        >
          {(["light", "dark", "system"] as const).map((p) => (
            <DropdownMenuRadioItem key={p} value={p}>
              {LABEL[p]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
