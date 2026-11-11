import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "./atomic.js";
import {
  currentBootId,
  currentPidNamespace,
  defaultAlive,
  processStartTicks,
  withProcessLock,
} from "./process-lock.js";

/**
 * Sliding window for the CLI assistant, the same 60s the server's in-memory limiter uses.
 * The server keeps that limiter; only the CLI writes this file.
 */
export const CLI_RATE_WINDOW_MS = 60_000;

const StampSchema = z.object({
  userId: z.string().min(1).max(500),
  at: z.number().finite(),
});
const BusySchema = z.object({
  userId: z.string().min(1).max(500),
  projectId: z.string().min(1).max(500),
  pid: z.number().int().positive(),
  at: z.number().finite(),
  boot: z.string().min(1).max(200).optional(),
  ticks: z.number().int().nonnegative().optional(),
  ns: z.string().min(1).max(200).optional(),
});
const FileSchema = z.object({
  rate: z.array(StampSchema),
  busy: z.array(BusySchema),
});

type State = z.infer<typeof FileSchema>;
type Busy = z.infer<typeof BusySchema>;

const empty = (): State => ({ rate: [], busy: [] });

/** `<root>/ratelimit/cli.json`. Mode 0600. Missing or unreadable counts as empty. */
export function cliRateLimitFile(root: string): string {
  return join(root, "ratelimit", "cli.json");
}

let nowForTests: (() => number) | undefined;

/** In-process clock for tests. Production leaves this unset and uses `Date.now`. */
export function setCliRateNowForTests(now: (() => number) | undefined): void {
  nowForTests = now;
}

/** Clock the CLI passes into the assistant. Tests replace it; a server process never reads it. */
export function cliRateNow(): number {
  return (nowForTests ?? Date.now)();
}

export type CliRateHoldPhase = "at-gate" | "in-lock";

let holdForTests: ((phase: CliRateHoldPhase) => Promise<void>) | undefined;

/**
 * In-process pause for the cross-process test. `at-gate` runs before the lock, `in-lock` only
 * when this call is about to take a free slot. Production leaves it unset.
 */
export function setCliRateHoldForTests(
  hold: ((phase: CliRateHoldPhase) => Promise<void>) | undefined,
): void {
  holdForTests = hold;
}

function lockPath(root: string): string {
  return join(root, "ratelimit", ".lock");
}

function withCliLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withProcessLock(
    lockPath(root),
    {},
    fn,
    (holder, path) =>
      new Error(
        `Another boof process is updating the CLI rate limit (pid ${holder}); try again in a moment, or remove ${path} if no boof process is running`,
      ),
  );
}

async function readState(path: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return empty();
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : empty();
  } catch {
    return empty();
  }
}

/**
 * A live holder, judged the same way as a process lock. A pid from another namespace is left
 * alone. Otherwise a dead pid, another boot, or a reused pid (different start ticks) is not busy.
 */
function busyLive(row: Busy): boolean {
  const ns = currentPidNamespace();
  if (row.ns !== undefined && row.ns !== ns) return true;
  if (!defaultAlive(row.pid)) return false;
  const boot = currentBootId();
  if (row.boot !== undefined && boot !== undefined && row.boot !== boot) return false;
  if (row.ticks !== undefined) {
    const ticks = processStartTicks(row.pid);
    if (ticks !== undefined && ticks !== row.ticks) return false;
  }
  return true;
}

/**
 * Drop a user's whole window when any of its stamps are in the future (the clock jumped
 * backwards). Then keep only the open 60s window. A busy mark from the future is dropped;
 * a busy mark whose process is gone is dropped.
 */
function fresh(state: State, now: number): State {
  const reset = new Set<string>();
  for (const row of state.rate) if (row.at > now) reset.add(row.userId);
  return {
    rate: state.rate.filter(
      (row) => !reset.has(row.userId) && row.at > now - CLI_RATE_WINDOW_MS && row.at <= now,
    ),
    busy: state.busy.filter((row) => row.at <= now && busyLive(row)),
  };
}

async function writeState(root: string, state: State): Promise<void> {
  const dir = join(root, "ratelimit");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = cliRateLimitFile(root);
  await atomicWrite(path, JSON.stringify(state, null, 2) + "\n", 0o600);
  await chmod(path, 0o600);
}

function ourBusy(userId: string, projectId: string): Busy {
  const boot = currentBootId();
  const ticks = processStartTicks(process.pid);
  const ns = currentPidNamespace();
  return {
    userId,
    projectId,
    pid: process.pid,
    at: 0,
    ...(boot !== undefined ? { boot } : {}),
    ...(ticks !== undefined ? { ticks } : {}),
    ...(ns !== undefined ? { ns } : {}),
  };
}

export async function takeCliTurn(input: {
  root: string;
  userId: string;
  projectId: string;
  limit: number;
  now: number;
}): Promise<
  | { ok: true; release: () => Promise<void> }
  | { ok: false; code: "rate_limited"; retryAfter: number }
  | { ok: false; code: "concierge_busy" }
> {
  const { root, userId, projectId, limit, now } = input;
  if (holdForTests) await holdForTests("at-gate");
  return withCliLock(root, async () => {
    const state = fresh(await readState(cliRateLimitFile(root)), now);
    const mine = state.rate.filter((row) => row.userId === userId);
    if (mine.length >= limit) {
      const oldest = Math.min(...mine.map((row) => row.at));
      await writeState(root, state);
      return {
        ok: false as const,
        code: "rate_limited" as const,
        retryAfter: Math.max(1, Math.ceil((oldest + CLI_RATE_WINDOW_MS - now) / 1000)),
      };
    }
    const next: State = {
      rate: [...state.rate, { userId, at: now }],
      busy: state.busy,
    };
    const flight = next.busy.find((row) => row.userId === userId && row.projectId === projectId);
    if (flight) {
      await writeState(root, next);
      return { ok: false as const, code: "concierge_busy" as const };
    }
    if (holdForTests) await holdForTests("in-lock");
    const mark = ourBusy(userId, projectId);
    mark.at = now;
    next.busy = [...next.busy, mark];
    await writeState(root, next);
    const pid = process.pid;
    return {
      ok: true as const,
      release: () => clearCliBusy({ root, userId, projectId, pid }),
    };
  });
}

/**
 * Drop this process's busy mark and leave the rate window untouched. A missing or corrupt file,
 * or a mark that is not ours, is left alone. The rate window is not re-judged here: a newer stamp
 * from another process must survive.
 */
export async function clearCliBusy(input: {
  root: string;
  userId: string;
  projectId: string;
  pid: number;
}): Promise<void> {
  const { root, userId, projectId, pid } = input;
  await withCliLock(root, async () => {
    const state = await readState(cliRateLimitFile(root));
    const busy = state.busy.filter(
      (row) => !(row.userId === userId && row.projectId === projectId && row.pid === pid),
    );
    if (busy.length === state.busy.length) return;
    await writeState(root, { rate: state.rate, busy });
  });
}
