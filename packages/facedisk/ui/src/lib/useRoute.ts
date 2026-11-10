import { useCallback, useEffect, useRef, useState } from "react";
import { appPathOf, basePath, isPlainLeftClick, locationKey, routeFromLocation } from "./location";
import { blockedByGuard, routeOfPath } from "./leave-guard";
import { formatRoute, routeAfterNavigation, type Route } from "./route";

const readRoute = (): Route | null =>
  routeFromLocation(window.location.pathname, basePath(document.baseURI));

const notify = () => window.dispatchEvent(new PopStateEvent("popstate"));

export function useRoute(): {
  route: Route | null;
  navigate(to: Route, opts?: { replace?: boolean }): void;
} {
  const [route, setRoute] = useState<Route | null>(readRoute);
  const searchRef = useRef(typeof window === "undefined" ? "" : window.location.search);

  useEffect(() => {
    const sync = () => {
      const next = readRoute();
      const search = window.location.search;
      const prevSearch = searchRef.current;
      searchRef.current = search;
      // Keep the same object when the path and the query are unchanged, so a popstate does not
      // re-render. A query-only change (`?epic=`, `?manage=`) still produces a new route.
      setRoute((prev) => routeAfterNavigation(prev, next, prevSearch, search));
    };
    window.addEventListener("popstate", sync);
    sync();
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    // Plain left clicks on in-app links become history navigation; modified clicks, downloads,
    // targets, api links and other origins stay with the browser.
    const onClick = (e: MouseEvent) => {
      if (!isPlainLeftClick(e) || !(e.target instanceof Element)) return;
      const a = e.target.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download")) return;
      if (a.target && a.target !== "_self") return;
      const path = appPathOf(a.href, document.baseURI);
      if (path === null) return;
      e.preventDefault();
      if (
        locationKey(path, document.baseURI) !==
        window.location.pathname + window.location.search
      ) {
        const go = () => {
          history.pushState(null, "", path);
          notify();
        };
        if (!blockedByGuard(routeOfPath(path), go)) go();
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const navigate = useCallback((to: Route, opts?: { replace?: boolean }) => {
    const path = formatRoute(to);
    if (opts?.replace) {
      history.replaceState(null, "", path);
      notify();
      return;
    }
    if (locationKey(path, document.baseURI) === window.location.pathname + window.location.search)
      return;
    const go = () => {
      history.pushState(null, "", path);
      notify();
    };
    // A screen with unsaved work may ask first; corrections (replace) never wait.
    if (!blockedByGuard(to, go)) go();
  }, []);

  return { route, navigate };
}
