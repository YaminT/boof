import { useSyncExternalStore } from "react";

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

/** A stored theme value. Anything else, including a cleared key, is system. */
export function themePrefFromStorage(value: string | null): ThemePref {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readThemePref(): ThemePref {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return themePrefFromStorage(v);
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

// One store shared by every useTheme caller, so a change made anywhere is seen everywhere.
let currentPref: ThemePref | null = null;
let currentSystemDark: boolean | null = null;
let mediaBound = false;
let mediaQuery: MediaQueryList | null = null;
let onMedia: (() => void) | null = null;
let onStorage: ((e: StorageEvent) => void) | null = null;
const listeners = new Set<() => void>();

function getPref(): ThemePref {
  return (currentPref ??= readThemePref());
}

function getSystemDark(): boolean {
  return (currentSystemDark ??= systemPrefersDark());
}

function notify(): void {
  for (const l of listeners) l();
}

function bindSystemListener(): void {
  if (mediaBound || typeof window === "undefined") return;
  mediaBound = true;
  // Re-read on every bind. The cache survives the gap after the last subscriber left, and an OS
  // or other-tab change in that gap would otherwise stick until the next event.
  let systemDark = false;
  try {
    const mq = window.matchMedia(DARK_QUERY);
    mediaQuery = mq;
    systemDark = mq.matches;
    onMedia = () => {
      currentSystemDark = mq.matches;
      if (getPref() === "system") applyTheme("system");
      notify();
    };
    mq.addEventListener("change", onMedia);
  } catch {
    // matchMedia unavailable: the system preference is treated as light
    mediaQuery = null;
    onMedia = null;
    systemDark = false;
  }
  currentSystemDark = systemDark;
  currentPref = readThemePref();
  applyTheme(currentPref);
  notify();
  // Other tabs write the same key. This tab does not hear its own writes.
  onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    currentPref = themePrefFromStorage(e.newValue);
    applyTheme(currentPref);
    notify();
  };
  window.addEventListener("storage", onStorage);
}

function unbindSystemListener(): void {
  if (!mediaBound || typeof window === "undefined") return;
  if (mediaQuery && onMedia) mediaQuery.removeEventListener("change", onMedia);
  if (onStorage) window.removeEventListener("storage", onStorage);
  mediaQuery = null;
  onMedia = null;
  onStorage = null;
  mediaBound = false;
}

/**
 * Keep the theme store listening for the life of the page. Theme controls unmount behind the
 * token gate and the add-project gate; without this, an OS or other-tab change in that gap is
 * missed until the next one.
 */
export function retainThemeStore(): () => void {
  return subscribe(() => {});
}

function subscribe(listener: () => void): () => void {
  bindSystemListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) unbindSystemListener();
  };
}

function setPref(p: ThemePref): void {
  currentPref = p;
  storePref(p);
  applyTheme(p);
  notify();
}

export function useTheme(): {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref(p: ThemePref): void;
} {
  const pref = useSyncExternalStore(subscribe, getPref, () => "system" as ThemePref);
  const systemDark = useSyncExternalStore(subscribe, getSystemDark, () => false);
  return { pref, resolved: resolveTheme(pref, systemDark), setPref };
}
