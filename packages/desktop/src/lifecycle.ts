// Desktop lifecycle logic kept free of `electron` so it can be unit-tested without an
// Electron runtime. main.ts wires these functions to the app, the server and the engine.
import type { RunnerEngine } from "@boof/runner";
import { browserSessionCookieName, parseKey } from "@boof/heart";
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
  /** Best-effort work after the engine drains (e.g. revoking the window's browser session). */
  cleanup?: () => Promise<void> | void;
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
        await deps.cleanup?.();
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
 * server's bound port. It has no `expirationDate`: a session cookie is dropped when the app quits,
 * so no admin-equivalent token is kept in the cookie database on disk.
 */
export function desktopSessionCookie(
  appOrigin: string,
  port: number,
  token: string,
): {
  url: string;
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "strict";
  path: "/";
} {
  return {
    url: appOrigin,
    name: browserSessionCookieName(port),
    value: token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  };
}

export interface WindowAuthDeps {
  /** The desktop key when safeStorage works; with one, no session is needed. */
  desktopToken: () => string | undefined;
  /** The data root's `auth.mode`. */
  loadAuthMode: () => Promise<string>;
  createSession: () => Promise<{ token: string; session: { id: string } }>;
  revokeSession: (id: string) => Promise<unknown>;
  setCookie: (cookie: ReturnType<typeof desktopSessionCookie>) => Promise<void>;
  warn: (line: string) => void;
  error: (line: string, err?: unknown) => void;
  /** Tells the user why the window will show the sign-in gate (a native dialog). */
  showFailure: (message: string) => Promise<void> | void;
  origin: string;
  port: number;
}

/**
 * Signs the app's own window in when there is no desktop key. `prepare()` runs before every
 * window load (first start and macOS `activate`): it mints a fresh browser session, sets the
 * session cookie, then revokes the session of the previous window so launches do not churn the
 * store's session cap. It never rejects: on failure the window still opens, on the sign-in gate.
 * Calls are serialised. `release()` revokes the current session on quit (best effort).
 */
export function createWindowAuth(deps: WindowAuthDeps): {
  prepare: () => Promise<void>;
  release: () => Promise<void>;
} {
  let currentId: string | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const revoke = async (id: string): Promise<void> => {
    try {
      await deps.revokeSession(id);
    } catch (err) {
      deps.error("desktop UI: could not revoke the previous browser session:", err);
    }
  };

  const run = async (): Promise<void> => {
    if (deps.desktopToken()) return;
    try {
      if ((await deps.loadAuthMode()) === "required") {
        deps.warn(
          'desktop UI: safeStorage unavailable and auth.mode is "required"; paste an API key in the window',
        );
        return;
      }
      const { token, session } = await deps.createSession();
      await deps.setCookie(desktopSessionCookie(deps.origin, deps.port, token));
      const previous = currentId;
      currentId = session.id;
      if (previous) await revoke(previous);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.error(
        "desktop UI: could not create a browser session; the window shows the sign-in gate:",
        reason,
      );
      try {
        await deps.showFailure(
          `Boof Runner could not sign its window in: ${reason}\n\nThe window will show the sign-in gate. Fix the problem named in this message and restart the app, or create an API key with "boof-runner auth add".`,
        );
      } catch {
        // the dialog is a courtesy
      }
    }
  };

  return {
    prepare: () => {
      const next = chain.then(run, run);
      chain = next;
      return next;
    },
    release: async () => {
      await chain.catch(() => {});
      const id = currentId;
      currentId = undefined;
      if (id) await revoke(id);
    },
  };
}
