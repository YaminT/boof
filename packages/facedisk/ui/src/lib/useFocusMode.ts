import { useCallback, useState } from "react";
import { readFocusMode, writeFocusMode, type FocusMode } from "./focus-mode.js";

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * A screen's remembered simple/expanded mode. The screen follows the choice at once, even when
 * the browser refuses to store it.
 */
export function useFocusMode(screen: string): {
  mode: FocusMode;
  expanded: boolean;
  toggle: () => void;
} {
  const [mode, setMode] = useState<FocusMode>(() => readFocusMode(screen, storage()));
  const toggle = useCallback(() => {
    setMode((m) => {
      const next: FocusMode = m === "simple" ? "expanded" : "simple";
      writeFocusMode(screen, next, storage());
      return next;
    });
  }, [screen]);
  return { mode, expanded: mode === "expanded", toggle };
}
