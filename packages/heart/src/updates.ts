import { chmod, readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWrite, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";
import { SettingsStore, updatesSettings } from "./settings.js";
import { RELEASE_REPOSITORY } from "./version.js";

/** At most one GitHub request in this window, counted from the last successful check. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A check that does not answer in this time is a failure. There is no retry. */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

/** `1.2.3` or `1.2.3-beta.1`, build metadata ignored. Null when it is not a version. */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = VERSION.exec(raw.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".").filter((part) => part.length > 0) : [],
  };
}

/** True when the version has a prerelease part (`0.4.0-beta.1`). */
export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.pre.length > 0;
}

function compareId(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  // Semver: numeric identifiers have lower precedence than non-numeric ones.
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence. Positive when `a` is newer than `b`. A release is newer than its own
 * prerelease (`1.0.0` > `1.0.0-beta.1`).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareId(pa.pre[i]!, pb.pre[i]!);
    if (c !== 0) return c;
  }
  return pa.pre.length - pb.pre.length;
}

/** Drop a single leading `v`. Null when the rest is not a version. */
export function versionFromTag(tag: string): string | null {
  const raw = tag.startsWith("v") || tag.startsWith("V") ? tag.slice(1) : tag;
  return parseVersion(raw) ? raw : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && value.length <= 2000;
  } catch {
    return false;
  }
}

/**
 * One request. A stable running version uses GitHub's `/releases/latest` (that endpoint already
 * omits prereleases and drafts). A prerelease running version uses the release list, because
 * `/releases/latest` would hide the newer prerelease the rule says to consider.
 */
export function releasesUrl(version: string): string {
  const base = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
  return isPrerelease(version) ? `${base}/releases?per_page=20` : `${base}/releases/latest`;
}

export function updateUserAgent(version: string): string {
  const safe = version.replace(/[^0-9A-Za-z.+-]/g, "") || "unknown";
  return `boof-runner/${safe}`;
}

export interface ReleaseNotice {
  version: string;
  url: string;
  prerelease: boolean;
}

interface GhRelease {
  tag_name: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

/** A GitHub release object, or a list of them. Null when the body is not that shape. */
export function parseReleases(body: unknown): GhRelease[] | null {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : null;
  if (!list) return null;
  const out: GhRelease[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.tag_name !== "string") return null;
    if (typeof r.html_url !== "string" || !isHttpsUrl(r.html_url)) return null;
    if (typeof r.prerelease !== "boolean" || typeof r.draft !== "boolean") return null;
    out.push({
      tag_name: r.tag_name,
      html_url: r.html_url,
      prerelease: r.prerelease,
      draft: r.draft,
    });
  }
  return out;
}

/**
 * The newest release that should be announced for `current`. Prereleases are ignored unless
 * `current` is itself a prerelease. Drafts are always ignored. Same or older versions are not
 * announced.
 */
export function chooseRelease(
  current: string,
  releases: readonly GhRelease[],
): ReleaseNotice | null {
  const allowPre = isPrerelease(current);
  let best: ReleaseNotice | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (release.prerelease && !allowPre) continue;
    const version = versionFromTag(release.tag_name);
    if (!version || compareVersions(version, current) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, url: release.html_url, prerelease: release.prerelease };
    }
  }
  return best;
}

const ReleaseNoticeSchema = z.strictObject({
  version: z.string(),
  url: z.string().refine(isHttpsUrl),
  prerelease: z.boolean(),
});

const UpdateCacheSchema = z.strictObject({
  checkedAt: z.string(),
  latest: ReleaseNoticeSchema.nullable(),
  dismissed: z.string().optional(),
});

export type UpdateCache = z.infer<typeof UpdateCacheSchema>;

export interface UpdateRequest {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
  redirect: "error";
}

export interface UpdateResponse {
  status: number;
  text(): Promise<string>;
}

export type UpdateFetch = (url: string, init: UpdateRequest) => Promise<UpdateResponse>;

/** Read `updates.json`. Missing, unreadable or the wrong shape is no cache. Does not create it. */
export async function readUpdateCache(root: string): Promise<UpdateCache | null> {
  try {
    const text = await readFile(dataRootPaths(root).updates, "utf8");
    const parsed = UpdateCacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeUpdateCache(root: string, cache: UpdateCache): Promise<void> {
  const path = dataRootPaths(root).updates;
  await atomicWrite(path, JSON.stringify(cache, null, 2) + "\n", 0o600);
  await chmod(path, 0o600).catch(() => {});
}

function fresh(cache: UpdateCache, now: Date): boolean {
  const at = Date.parse(cache.checkedAt);
  return !Number.isNaN(at) && now.getTime() - at < UPDATE_CHECK_INTERVAL_MS;
}

/**
 * The line `boof-runner --version` prints under the version, from the cache only.
 * Dismissal is a UI action: the terminal still names a newer release.
 */
export function cliNoticeLine(current: string, cache: UpdateCache | null): string | null {
  const latest = cache?.latest;
  if (!latest) return null;
  if (latest.prerelease && !isPrerelease(current)) return null;
  if (!parseVersion(latest.version) || compareVersions(latest.version, current) <= 0) return null;
  return `New version available: ${latest.version} ${latest.url}`;
}

/** What the UI shows. A dismissed version stays hidden until a newer one is cached. */
export function uiNotice(
  current: string,
  cache: UpdateCache | null,
): { version: string; url: string } | null {
  if (cache?.dismissed && cache.dismissed === cache.latest?.version) return null;
  const line = cliNoticeLine(current, cache);
  if (!line || !cache?.latest) return null;
  return { version: cache.latest.version, url: cache.latest.url };
}

async function defaultFetch(url: string, init: UpdateRequest): Promise<UpdateResponse> {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
}

export interface CheckForUpdateOptions {
  root: string;
  version: string;
  /** Test seam. Production uses `fetch`. */
  fetchImpl?: UpdateFetch;
  now?: () => Date;
  /** Defaults to `process.env`. A set `BOOF_RUNNER_AGENT_OF` sends nothing. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Ask GitHub once, when the setting allows it and the cache is older than a day.
 * Any network or parse failure is silent and leaves the previous `updates.json` bytes in place.
 * An agent process (`BOOF_RUNNER_AGENT_OF`) never sends the request.
 * A vitest process does not either, unless the test passes `fetchImpl`: the suite must not call GitHub.
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<void> {
  const env = opts.env ?? process.env;
  if (typeof env.BOOF_RUNNER_AGENT_OF === "string" && env.BOOF_RUNNER_AGENT_OF.length > 0) return;
  if (!opts.fetchImpl && (env.VITEST || env.VITEST_WORKER_ID)) return;
  let enabled = true;
  try {
    enabled = updatesSettings(await new SettingsStore(opts.root).load()).check;
  } catch {
    return;
  }
  if (!enabled) return;

  const path = dataRootPaths(opts.root).updates;
  const now = opts.now ?? (() => new Date());
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;

  await withFileLock(path, async () => {
    const cache = await readUpdateCache(opts.root);
    const at = now();
    if (cache && fresh(cache, at)) return;
    let status = 0;
    let body = "";
    try {
      const res = await fetchImpl(releasesUrl(opts.version), {
        method: "GET",
        headers: {
          "user-agent": updateUserAgent(opts.version),
          accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      status = res.status;
      if (status === 200) body = await res.text();
    } catch {
      return;
    }
    if (status !== 200) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    const releases = parseReleases(parsed);
    if (!releases) return;
    const latest = chooseRelease(opts.version, releases);
    const next: UpdateCache = {
      checkedAt: at.toISOString(),
      latest,
      ...(cache?.dismissed ? { dismissed: cache.dismissed } : {}),
    };
    await writeUpdateCache(opts.root, next);
  });
}

/** Hide the named version in the UI. A different version, or no cache, changes nothing. */
export async function dismissUpdate(root: string, version: string): Promise<void> {
  const path = dataRootPaths(root).updates;
  await withFileLock(path, async () => {
    const cache = await readUpdateCache(root);
    if (!cache?.latest || cache.latest.version !== version || cache.dismissed === version) return;
    await writeUpdateCache(root, { ...cache, dismissed: version });
  });
}
