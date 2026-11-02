import { parseRoute, type Route } from "./route";

/** Pathname of the document base, always ending in "/". */
export function basePath(baseURI: string): string {
  const p = new URL(baseURI).pathname;
  return p.endsWith("/") ? p : p + "/";
}

/** The route for a pathname under `base`; null for the bare mount point, index.html or elsewhere. */
export function routeFromLocation(pathname: string, base: string): Route | null {
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  if (rest === "" || rest === "index.html") return null;
  return parseRoute(rest);
}

/** App-relative path replacing a legacy `#/...` URL ("./" when unknown); null if not a legacy hash. */
export function legacyHashTarget(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const path = hash.slice(2);
  return parseRoute(path) ? path.replace(/\/+$/, "") : "./";
}

/** The app-relative path for a same-origin link under the base that is a route; else null. */
export function appPathOf(href: string, baseURI: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href);
    base = new URL(baseURI);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.hash) return null;
  const prefix = basePath(baseURI);
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  if (!parseRoute(rest)) return null;
  return rest + url.search;
}

export function isPlainLeftClick(
  e: Pick<
    MouseEvent,
    "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented"
  >,
): boolean {
  return (
    e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented
  );
}
