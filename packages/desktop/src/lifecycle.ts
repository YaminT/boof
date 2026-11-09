// Desktop lifecycle logic kept free of `electron` so it can be unit-tested without an
// Electron runtime. main.ts wires these functions to the app, the server and the engine.
import type { RunnerEngine } from "@boof/runner";
import { BROWSER_SESSION_MAX_MS, browserSessionCookieName, parseKey } from "@boof/heart";
import type { RunningServer } from "@boof/heart-server";

/**
 * The id of the client the desktop's own key belongs to, read from the key it holds. After the
 * `desktop-ui` client is revoked a new one (`desktop-ui-<hex>`) is issued, so the id is not a constant.
 */
export function operatorClientId(token: string | undefined): string | undefined {
  return token ? parseKey(token)?.clientId : undefined;
}

const DEFAULT_GRACE_MS = 30_000;

/** Grace period for a graceful shutdown, from BOOF_RUNNER_SHUTDOWN_GRACE_MS (default 30 s). */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.BOOF_RUNNER_SHUTDOWN_GRACE_MS ?? DEFAULT_GRACE_MS);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_GRACE_MS;
}

export interface QuitDeps {
  engine: () => Pick<RunnerEngine, "shutdown"> | null;
  server: () => Pick<RunningServer, "stop"> | null;
  exit: (code: number) => void;
  graceMs: number;
  log: (line: string) => void;
  /** Shown to the user while the engine drains (a notification or the window title). */
  notify?: (message: string) => void;
}

/** What the user sees while a quit waits for the running task to stop. */
export const QUIT_DRAIN_NOTICE = "Stopping running task... (quit again to force)";

export interface QuitEvent {
  preventDefault(): void;
}

/**
 * Handler for Electron's `before-quit`. The first request defers the quit, drains the
 * engine (running tasks end as `stopped`), stops the server and exits 0. A second
 * request while draining is not deferred, so Electron quits at once.
 */
export function createQuitHandler(deps: QuitDeps): (event: QuitEvent) => Promise<void> | undefined {
  let draining = false;
  return (event) => {
    if (draining) return undefined;
    draining = true;
    event.preventDefault();
    return (async () => {
      try {
        const engine = deps.engine();
        if (engine) {
          deps.notify?.(QUIT_DRAIN_NOTICE);
          const { stopped, timedOut } = await engine.shutdown(deps.graceMs);
          if (stopped.length > 0) deps.log(`Stopped running task(s): ${stopped.join(", ")}`);
          if (timedOut) deps.log(`Grace period of ${deps.graceMs} ms elapsed; quitting anyway`);
        }
        await deps.server()?.stop();
      } catch (err) {
        deps.log(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        deps.exit(0);
      }
    })();
  };
}

/** True when `url` is a page of the app's own server: same origin, no userinfo. */
export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !u.username && !u.password && u.origin === appOrigin;
  } catch {
    return false;
  }
}

/** True for URLs that may be handed to the system browser: http(s) only. */
export function isExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * The cookie the desktop app sets in its own window when it has no desktop key (safeStorage is
 * unavailable). It is the browser-session cookie the server already accepts, named after the
 * server's bound port, and it expires with the session's absolute 30-day limit.
 */
export function desktopSessionCookie(
  appOrigin: string,
  port: number,
  token: string,
  nowMs: number,
): {
  url: string;
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "strict";
  path: "/";
  expirationDate: number;
} {
  return {
    url: appOrigin,
    name: browserSessionCookieName(port),
    value: token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    expirationDate: (nowMs + BROWSER_SESSION_MAX_MS) / 1000,
  };
}
