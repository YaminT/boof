import { useCallback, useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "boof-runner.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

function systemPrefersDark(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function readThemePref(): ThemePref {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(pref, systemPrefersDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
}

function storePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // storage unavailable: the preference lasts for this page load only
  }
}

export function useTheme(): {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref(p: ThemePref): void;
} {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    if (pref !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      setSystemDark(mq.matches);
      applyTheme("system");
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    storePref(p);
    applyTheme(p);
    setPrefState(p);
  }, []);

  return { pref, resolved: resolveTheme(pref, systemDark), setPref };
}
