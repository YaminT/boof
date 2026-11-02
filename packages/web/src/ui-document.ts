import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";

/**
 * Relative `<base href>` for a request path: "./" at the root level, otherwise one "../" per
 * extra path segment. Works from the raw (still encoded) path, so `%2F` does not count as a
 * segment. Relative, so the UI also works behind a proxy that strips a prefix such as /boof/.
 */
export function relativeBase(rawPath: string): string {
  const depth = rawPath.split("/").length - 2;
  return depth <= 0 ? "./" : "../".repeat(depth);
}

const PROJECT_PATH = /^\/p\/[^/]+(?:\/[^/]+){0,3}\/?$/;

/** Paths the single-page UI answers: the shell, the inbox and the project routes. */
export function isUiPath(rawPath: string): boolean {
  return (
    rawPath === "/" ||
    rawPath === "/index.html" ||
    rawPath === "/inbox" ||
    rawPath === "/inbox/" ||
    PROJECT_PATH.test(rawPath)
  );
}

/** Serves `index.html` with a `<base href>` worked out from the request depth only. */
export function uiDocument(uiDir: string): (c: Context) => Promise<Response> {
  return async (c) => {
    let html: string;
    try {
      html = await readFile(join(uiDir, "index.html"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.notFound();
      throw err;
    }
    const tag = `<base href="${relativeBase(new URL(c.req.url).pathname)}">`;
    const body = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + tag)
      : tag + html;
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
  };
}
