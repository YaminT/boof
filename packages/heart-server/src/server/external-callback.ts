import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  appendAuditLine,
  EXTERNAL_RUN_ID,
  type ExternalRunStore,
  type SecuritySettings,
} from "@boof/heart";
import { clientAddress } from "./middleware/client-address.js";
import type { PeerAddressResolver } from "./middleware/auth.js";
import { unauthenticatedRateLimit } from "./middleware/rate-limit.js";

export const CALLBACK_BODY_LIMIT = 300_000;

export const ExternalCallbackBodySchema = z.strictObject({
  status: z.enum(["ok", "failed"]),
  report: z.string().max(65_536),
  summary: z.string().max(300).optional(),
});

const INVALID_TOKEN_MESSAGE = "Unknown, closed or expired step run, or a wrong token";

/** Read at most `limit` bytes of the body; `undefined` when it is larger. */
async function readCapped(req: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * `POST /external-steps/:runId`, mounted at `/callbacks`: n8n's protocol endpoint, outside the
 * API-key chain. The per-run bearer token is its only credential; it gives no keyless rights in
 * either auth mode and every refusal is the same 401 (see the design's callback section).
 */
export function externalCallbackRoutes(deps: {
  root: string;
  runs: ExternalRunStore;
  security: () => Promise<SecuritySettings>;
  peerAddress: PeerAddressResolver;
  now?: () => number;
}): Hono {
  const now = deps.now ?? Date.now;
  const routes = new Hono();
  routes.use(
    "*",
    unauthenticatedRateLimit({
      security: deps.security,
      peerAddress: deps.peerAddress,
      now: deps.now,
    }),
  );

  routes.post("/external-steps/:runId", async (c: Context) => {
    const start = now();
    const runId = c.req.param("runId") ?? "";
    const audit: Record<string, unknown> = {
      runId: EXTERNAL_RUN_ID.test(runId) ? runId : "(malformed)",
    };
    let status = 500;
    let outcome = "error";

    const answer = (
      st: number,
      out: string,
      body: unknown,
      extra?: Record<string, unknown>,
    ): Response => {
      status = st;
      outcome = out;
      Object.assign(audit, extra);
      c.header("Cache-Control", "no-store");
      return c.json(body, st as 400);
    };
    const error = (st: number, code: string, message: string, details?: unknown): Response =>
      answer(st, code, { error: { code, message, ...(details ? { details } : {}) } });
    /** A refusal spends the caller's unauthenticated budget; an empty bucket answers 429 instead. */
    const refuse = (st: number, code: string, message: string, details?: unknown): Response => {
      const limited = c.get("authFailed")?.(c);
      if (limited) {
        status = 429;
        outcome = "rate_limited";
        return limited;
      }
      return error(st, code, message, details);
    };
    const invalidToken = () => refuse(401, "invalid_step_token", INVALID_TOKEN_MESSAGE);

    try {
      // 1. Not a browser endpoint.
      if (c.req.header("origin") !== undefined || c.req.header("sec-fetch-site") !== undefined) {
        return refuse(
          403,
          "origin_not_allowed",
          "The callback is not a browser endpoint: remove the Origin and Sec-Fetch headers",
        );
      }
      // 2. Declared size (the stream is capped again when it is read).
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > CALLBACK_BODY_LIMIT) {
        return refuse(413, "payload_too_large", "Request body too large");
      }
      // 3. Media type; parameters such as charset are allowed.
      const media = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (media !== "application/json") {
        return refuse(
          415,
          "unsupported_media_type",
          "The callback needs Content-Type: application/json",
        );
      }
      // 4. The unauthenticated limiter is the middleware above; refusals draw on it.
      // 5. The token comes from the Authorization header only.
      const match = /^Bearer ([^\s]+)$/i.exec(c.req.header("authorization") ?? "");
      const record = await deps.runs.verify(runId, match?.[1]);
      if (!record) return invalidToken();
      Object.assign(audit, { project: record.projectId, task: record.taskId, step: record.stepId });
      // 6. The body. A bad one does not use up the token.
      const bytes = await readCapped(c.req.raw, CALLBACK_BODY_LIMIT);
      if (!bytes) return refuse(413, "payload_too_large", "Request body too large");
      let parsed: z.ZodSafeParseResult<z.infer<typeof ExternalCallbackBodySchema>>;
      try {
        parsed = ExternalCallbackBodySchema.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        return error(400, "invalid_input", "The body is not valid JSON", {
          issues: [{ path: "", message: "not valid JSON" }],
        });
      }
      if (!parsed.success) {
        return error(400, "invalid_input", "The body does not match the callback schema", {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      // 7. Close the run: the first caller wins.
      const body = parsed.data;
      const won = await deps.runs.complete(runId, {
        status: body.status,
        report: body.report,
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
      });
      if (!won) return invalidToken();
      // 8.
      return answer(200, "ok", { ok: true }, { result: body.status });
    } finally {
      try {
        const security = await deps.security();
        if (security.audit.enabled) {
          const peer = c.get("peerAddress");
          const addr =
            c.get("clientAddress") ??
            clientAddress((n) => c.req.header(n), peer, security.trustedProxies);
          await appendAuditLine(deps.root, {
            ts: new Date(start).toISOString(),
            principal: "external-step",
            kind: "run-token",
            action: "callback:external-step",
            outcome,
            status,
            ms: now() - start,
            ...audit,
            ip: peer ?? null,
            ...(addr.forwardedFor ? { forwardedFor: addr.forwardedFor } : {}),
          });
        }
      } catch (err) {
        console.error("audit write failed", err);
      }
    }
  });

  return routes;
}
