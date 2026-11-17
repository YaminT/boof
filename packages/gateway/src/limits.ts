/**
 * Turns one upstream answer into an account outcome. No I/O and no clock of its own: the caller
 * passes `now` (ms). The error-body table is kept in one place so it can be corrected against
 * the current Anthropic docs without touching the pool.
 */

export type Outcome =
  | { kind: "ok" }
  /** 429: the account is paused until `until` (epoch ms). */
  | { kind: "rate_limited"; until: number }
  /** 401: the key is rejected; paused until the user acts. */
  | { kind: "auth" }
  /** Credit balance or spend limit reached; rechecked later. */
  | { kind: "credit" }
  /** 5xx / 529 / overloaded: not the account's fault. */
  | { kind: "transient" }
  /** Any other 4xx: a problem with the request, not the account. */
  | { kind: "other" };

export const DEFAULT_RESET_MS = 60_000;
/** A reset further away than this is treated as garbled and capped. */
export const MAX_RESET_MS = 24 * 60 * 60_000;
/** How long a credit/spend-limit account sits out before it is tried again. */
export const CREDIT_RECHECK_MS = 60 * 60_000;

/**
 * Lower-case prefixes of a 400 `invalid_request_error` message that mean "out of credit or spend
 * limit". Anchored at the start: the message may echo client text (e.g. a model name), so a
 * substring match would let a caller poison the pool.
 */
export const CREDIT_MARKERS = [
  "your credit balance is too low",
  "you have reached your specified",
  "you have reached your api usage limits",
];
/** `error.details.error_code` of the 429 tier spend cap (no retry-after; lasts until the month ends). */
export const SPEND_CAP_ERROR_CODE = "enforced_spend_limit_reached";
// Docs: https://platform.claude.com/docs/en/api/errors and /docs/en/api/rate-limits
const CREDIT_ERROR_TYPES = ["billing_error"];
const RESET_HEADERS = [
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-reset",
];

export type HeaderBag =
  { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function header(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue;
    const v = record[key];
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** `retry-after` as an epoch-ms time (delta seconds or HTTP-date), or undefined when unusable. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return now + Math.min(Number(v) * 1000, MAX_RESET_MS);
  const at = Date.parse(v);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return Math.min(at, now + MAX_RESET_MS);
}

/** The latest `anthropic-ratelimit-*-reset` time (RFC 3339), or undefined. */
export function parseRatelimitReset(
  headers: HeaderBag | undefined,
  now: number,
): number | undefined {
  let latest: number | undefined;
  for (const name of RESET_HEADERS) {
    const raw = header(headers, name)?.trim();
    if (!raw) continue;
    const at = Date.parse(raw);
    if (!Number.isFinite(at) || at <= now) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest === undefined ? undefined : Math.min(latest, now + MAX_RESET_MS);
}

/** The time a 429 account is usable again: retry-after, then reset headers, then 60 s. */
export function resetTime(headers: HeaderBag | undefined, now: number): number {
  return (
    parseRetryAfter(header(headers, "retry-after"), now) ??
    parseRatelimitReset(headers, now) ??
    now + DEFAULT_RESET_MS
  );
}

function errorInfo(body: string | undefined): { type: string; message: string; code: string } {
  const text = (body ?? "").slice(0, 8192);
  try {
    const json = JSON.parse(text) as {
      error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } };
    };
    const type = typeof json.error?.type === "string" ? json.error.type : "";
    const message = typeof json.error?.message === "string" ? json.error.message : "";
    const code =
      typeof json.error?.details?.error_code === "string" ? json.error.details.error_code : "";
    return { type, message, code };
  } catch {
    return { type: "", message: text, code: "" };
  }
}

export interface UpstreamAnswer {
  status: number;
  headers?: HeaderBag;
  /** The (possibly truncated) error body; only read for non-2xx answers. */
  body?: string;
}

/** Classify one upstream answer. */
export function classify(answer: UpstreamAnswer, now: number): Outcome {
  const { status } = answer;
  if (status >= 200 && status < 400) return { kind: "ok" };
  const info = errorInfo(answer.body);
  // Only a rejected key pauses an account; 403 (permission_error) is a request problem.
  if (status === 401 && info.type === "authentication_error") return { kind: "auth" };
  const lower = info.message.trim().toLowerCase();
  if (status === 429 && info.code === SPEND_CAP_ERROR_CODE) return { kind: "credit" };
  const credit =
    status === 402 ||
    (status !== 404 && status < 500 && status !== 429 && CREDIT_ERROR_TYPES.includes(info.type)) ||
    (status === 400 &&
      info.type === "invalid_request_error" &&
      CREDIT_MARKERS.some((m) => lower.startsWith(m)));
  if (credit) return { kind: "credit" };
  if (status === 429) return { kind: "rate_limited", until: resetTime(answer.headers, now) };
  if (status === 529 || status >= 500 || info.type === "overloaded_error") {
    return { kind: "transient" };
  }
  return { kind: "other" };
}
