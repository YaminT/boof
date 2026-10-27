import { useCallback, useEffect, useState } from "react";
import { formatRoute, parseRoute, type Route } from "./route";

export function useRoute(): {
  route: Route | null;
  navigate(to: Route, opts?: { replace?: boolean }): void;
} {
  const [route, setRoute] = useState<Route | null>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", sync);
    sync();
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((to: Route, opts?: { replace?: boolean }) => {
    const hash = formatRoute(to);
    if (opts?.replace) history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  return { route, navigate };
}
