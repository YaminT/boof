import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStore,
  CHANGE_TTL_MS,
  isInterruptedApply,
  CONCIERGE_TOOL_ID,
  ConciergeStore,
  conciergeDir,
  ConciergeTurnError,
  MAX_PENDING_PER_CONVERSATION,
  auditOperation,
  appendAuditLine,
  securitySettings,
  blockingScopes,
  budgetTimeZone,
  conciergeSettings,
  evaluateBudget,
  recordSpend,
  sumUsage,
  type ConciergeAgent,
  type ConciergeAvailability,
  type ConciergeConversation,
  type PendingChange,
  type Principal,
  type Project,
  type TokenUsage,
} from "@boof/heart";
import { OpError } from "../api/errors.js";
import { promptFingerprint } from "../api/audit.js";
import type { TaskService } from "../api/services/service.js";
import {
  conciergeAllowedTools,
  conciergeCanList,
  userMayApply,
  conciergeOps,
  assertConfirmInput,
  normalizeConfirmInput,
  conciergePrincipal,
  assertConciergeIdAvailable,
  RESULT_TEXT_CAP,
  CONCIERGE_TOOLS,
} from "./policy.js";
import {
  buildConciergeMessage,
  CONCIERGE_MCP_INSTRUCTIONS,
  CONCIERGE_SYSTEM_PROMPT,
  type ResolvedContext,
} from "./prompt.js";
import { previewChange } from "./preview.js";

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const ConciergeContextSchema = z.strictObject({
  screen: z.enum(["overview", "tasks", "task", "plans", "settings", "inbox"]),
  taskId: kebab.optional(),
  planId: kebab.optional(),
  goalId: kebab.optional(),
});
export type ConciergeEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; phase: "start" | "end"; ok?: boolean }
  | {
      type: "change";
      op: string;
      summary: string;
      target: { kind: "task" | "plan" | "epic"; id: string } | null;
    }
  | { type: "pending"; change: PendingChangeView }
  | { type: "done"; answer: ConciergeAnswer }
  | { type: "error"; code: string; message: string };
export type PendingChangeView = Pick<
  PendingChange,
  | "id"
  | "op"
  | "title"
  | "details"
  | "destructive"
  | "blocked"
  | "reason"
  | "status"
  | "expiresAt"
  | "error"
>;
export interface ConciergeAnswer {
  conversationId: string;
  text: string;
  changes: {
    op: string;
    summary: string;
    target: { kind: "task" | "plan" | "epic"; id: string } | null;
  }[];
  pending: PendingChangeView[];
  costUsd: number | null;
  stopReason: "done" | "max_turns" | "max_budget";
}
export interface ConciergeStatus {
  available: boolean;
  reason: string | null;
  via: "gateway" | "project-key" | null;
  model: string;
  limits: { perMessageUsd: number; perConversationUsd: number; messagesPerMinute: number };
  conversation: {
    id: string;
    spentUsd: number;
    messages: number;
    pending: PendingChangeView[];
  } | null;
}

export class ConciergeService {
  private readonly store: ConciergeStore;
  private readonly inFlight = new Set<string>();
  private readonly rate = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      root: string;
      services: TaskService;
      authStore: AuthStore;
      agent: ConciergeAgent | null;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.store = new ConciergeStore(opts.root, this.now);
  }

  async status(user: Principal, projectId: string): Promise<ConciergeStatus> {
    const project = await this.opts.services.getProject(projectId);
    const settings = await this.opts.services.loadSettings();
    const cfg = conciergeSettings(settings);
    let availability: ConciergeAvailability = {
      available: false,
      reason: "The assistant is not set up in this boof process.",
      via: null as "gateway" | "project-key" | null,
    };
    if (!cfg.enabled)
      availability = {
        available: false,
        reason: "The assistant is turned off (settings.concierge.enabled is false).",
        via: null,
      };
    else if (this.opts.agent) availability = await this.opts.agent.availability(project);
    const conversation = await this.readStatusConversation(
      projectId,
      user.id,
      cfg.idleMinutes * 60_000,
    );
    return {
      ...availability,
      model: cfg.model,
      limits: {
        perMessageUsd: cfg.perMessageUsd,
        perConversationUsd: cfg.perConversationUsd,
        messagesPerMinute: cfg.messagesPerMinute,
      },
      conversation: conversation && {
        id: conversation.id,
        spentUsd: conversation.spentUsd,
        messages: conversation.messages,
        pending: statusViews(conversation),
      },
    };
  }

  /** Read the live conversation without creating, expiring, or otherwise changing it. */
  private async readStatusConversation(projectId: string, owner: string, idleMs: number) {
    const dir = conciergeDir(this.opts.root, projectId);
    try {
      const live = JSON.parse(await readFile(join(dir, "live.json"), "utf8")) as {
        owners?: Record<string, string>;
      };
      const id = live.owners?.[owner];
      if (!id || !/^cnv-[0-9a-f]{8}$/.test(id)) return null;
      const conversation = await (
        this.store as unknown as {
          readConversation(
            projectId: string,
            id: string,
          ): Promise<ConciergeConversation | null | "corrupt">;
        }
      ).readConversation(projectId, id);
      if (!conversation || conversation === "corrupt") return null;
      if (
        conversation.id !== id ||
        conversation.projectId !== projectId ||
        conversation.owner !== owner ||
        this.now() - Date.parse(conversation.updatedAt) >= idleMs ||
        this.now() < Date.parse(conversation.updatedAt)
      )
        return null;
      return {
        ...conversation,
        changes: conversation.changes.map((change) =>
          isInterruptedApply(change, this.now())
            ? { ...change, status: "failed" as const, error: "interrupted" }
            : change,
        ),
      };
    } catch {
      return null;
    }
  }

  async ask(
    user: Principal,
    projectId: string,
    input: {
      text: string;
      context?: z.input<typeof ConciergeContextSchema>;
      conversationId?: string;
    },
    onEvent?: (e: ConciergeEvent) => void,
    signal?: AbortSignal,
  ): Promise<ConciergeAnswer> {
    const startedAt = this.now();
    const text = input.text.trim();
    if (text.length < 1 || text.length > 4000)
      throw new OpError(400, "Text must be 1-4000 characters", "invalid_input");
    const context =
      input.context === undefined ? undefined : ConciergeContextSchema.parse(input.context);
    const settings = await this.opts.services.loadSettings();
    const cfg = conciergeSettings(settings);
    if (!cfg.enabled)
      throw new OpError(
        409,
        "The assistant is turned off (settings.concierge.enabled is false).",
        "concierge_unavailable",
      );
    if (!this.opts.agent)
      throw new OpError(
        409,
        "The assistant is not set up in this boof process.",
        "concierge_unavailable",
      );
    const project = await this.opts.services.getProject(projectId);
    try {
      await assertConciergeIdAvailable(user, this.opts.authStore);
    } catch (err) {
      throw new OpError(
        409,
        err instanceof Error ? err.message : "Assistant identity unavailable",
        "concierge_unavailable",
      );
    }
    const availability = await this.opts.agent.availability(project);
    if (!availability.available)
      throw new OpError(
        409,
        availability.reason ?? "Assistant unavailable",
        "concierge_unavailable",
      );
    this.checkRate(user.id, cfg.messagesPerMinute);
    const flightKey = `${user.id}\0${projectId}`;
    if (this.inFlight.has(flightKey))
      throw new OpError(
        409,
        "A message to the assistant is still being answered.",
        "concierge_busy",
      );
    this.inFlight.add(flightKey);
    try {
      const settingsBudget = settings;
      const budget = await evaluateBudget(
        this.opts.root,
        settingsBudget,
        [project],
        new Date(this.now()),
      );
      const blocked = blockingScopes(budget, projectId, [CONCIERGE_TOOL_ID]);
      if (blocked.length)
        throw new OpError(
          409,
          "A daily budget that covers the assistant is used up.",
          "budget_exceeded",
          { scopes: blocked.map((s) => s.scope), resetsAt: budget.resetsAt },
        );
      const conversation = await this.conversationFor(
        projectId,
        user.id,
        input.conversationId,
        cfg.idleMinutes * 60_000,
      );
      if (conversation.spentUsd >= cfg.perConversationUsd)
        throw new OpError(
          409,
          "The conversation reached its cost limit; start a new one.",
          "concierge_limit",
        );
      const caps = [
        cfg.perMessageUsd,
        cfg.perConversationUsd - conversation.spentUsd,
        ...budget.scopes
          .filter(
            (s) =>
              [
                "global",
                `project:${projectId}`,
                `tool:${CONCIERGE_TOOL_ID}`,
                `project:${projectId}/tool:${CONCIERGE_TOOL_ID}`,
              ].includes(s.scope) && s.remainingUsd !== null,
          )
          .map((s) => s.remainingUsd!),
      ];
      const maxBudgetUsd = Math.max(0.000001, Math.min(...caps));
      const projectService = await this.opts.services.requireProject(projectId);
      const resolved = await this.resolveContext(project, projectService, context);
      const principal = conciergePrincipal(user, projectId);
      let messagePending = 0;
      let toolCount = 0;
      const changes: ConciergeAnswer["changes"] = [];
      const gate = {
        before: async (op: (typeof registry)[number], raw: Record<string, unknown>) => {
          if (CONCIERGE_TOOLS[op.name] !== "confirm") return undefined;
          const parsed = op.input.safeParse(raw);
          if (!parsed.success)
            throw new OpError(
              400,
              `Invalid input: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
              "invalid_input",
            );
          if (!userMayApply(op, user, projectId))
            throw new OpError(
              403,
              "You may not make this change, so it cannot be proposed",
              "forbidden_scope",
            );
          const confirmInput = normalizeConfirmInput(
            op.name,
            parsed.data as Record<string, unknown>,
          );
          assertConfirmInput(op.name, confirmInput, projectId);
          if (messagePending >= 5) {
            return {
              summary: "The pending change limit has been reached.",
              structured: { limit: 5 },
            };
          }
          messagePending++;
          let stored = false;
          try {
            const preview = await previewChange(op, confirmInput, projectService);
            const now = this.now();
            const change: PendingChange = {
              id: `chg-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
              op: op.name,
              input: confirmInput,
              title: preview.title,
              details: preview.details,
              destructive: preview.destructive,
              ...(preview.blocked ? { blocked: preview.blocked } : {}),
              reason: "confirm",
              guard: preview.guard,
              status: "pending",
              createdAt: new Date(now).toISOString(),
              expiresAt: new Date(now + CHANGE_TTL_MS).toISOString(),
            };
            let conversationLimit = false;
            await this.store.update(projectId, conversation.id, (c) => {
              if (
                c.changes.filter((x) => x.status === "pending").length >=
                MAX_PENDING_PER_CONVERSATION
              ) {
                conversationLimit = true;
                return;
              }
              c.changes.push(change);
            });
            if (conversationLimit) {
              messagePending--;
              return {
                summary: "The pending change limit has been reached.",
                structured: { limit: MAX_PENDING_PER_CONVERSATION },
              };
            }
            stored = true;
            onEvent?.({ type: "pending", change: toView(change) });
            const copy = `Waiting for the user's confirmation (change ${change.id}): ${change.title}. Do not call this tool again for it; tell the user in one sentence what will change.`;
            return {
              summary: copy,
              structured: { pending: true, changeId: change.id, title: change.title },
            };
          } catch (err) {
            if (!stored) messagePending--;
            throw err;
          }
        },
        refused: async (
          op: (typeof registry)[number],
          raw: Record<string, unknown>,
          err: OpError,
        ) => {
          if (CONCIERGE_TOOLS[op.name] !== "write" || err.code !== "forbidden_trust")
            return undefined;
          const parsed = op.input.safeParse(raw);
          if (!parsed.success)
            throw new OpError(
              400,
              `Invalid input: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
              "invalid_input",
            );
          if (messagePending >= 5)
            return {
              summary: "The pending change limit has been reached.",
              structured: { limit: 5 },
            };
          messagePending++;
          let stored = false;
          try {
            const preview = await previewChange(
              op,
              parsed.data as Record<string, unknown>,
              projectService,
            );
            const now = this.now();
            const change: PendingChange = {
              id: `chg-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
              op: op.name,
              input: parsed.data as Record<string, unknown>,
              title: preview.title,
              details: preview.details,
              destructive: preview.destructive,
              ...(preview.blocked ? { blocked: preview.blocked } : {}),
              reason: "needs-approval",
              guard: preview.guard,
              status: "pending",
              createdAt: new Date(now).toISOString(),
              expiresAt: new Date(now + CHANGE_TTL_MS).toISOString(),
            };
            let conversationLimit = false;
            await this.store.update(projectId, conversation.id, (c) => {
              if (
                c.changes.filter((x) => x.status === "pending").length >=
                MAX_PENDING_PER_CONVERSATION
              ) {
                conversationLimit = true;
                return;
              }
              c.changes.push(change);
            });
            if (conversationLimit) {
              messagePending--;
              return {
                summary: "The pending change limit has been reached.",
                structured: { limit: MAX_PENDING_PER_CONVERSATION },
              };
            }
            stored = true;
            onEvent?.({ type: "pending", change: toView(change) });
            return {
              summary: `Waiting for the user's confirmation (change ${change.id}): ${change.title}. Do not call this tool again for it; tell the user in one sentence what will change.`,
              structured: { pending: true, changeId: change.id, title: change.title },
            };
          } catch (err) {
            if (!stored) messagePending--;
            throw err;
          }
        },
        after: async (
          op: (typeof registry)[number],
          _raw: Record<string, unknown>,
          result: unknown,
        ) => {
          const mode = CONCIERGE_TOOLS[op.name];
          if (mode === "write") {
            const target = targetOf(op.name, result);
            const summary = op.summary ? op.summary(result as never) : op.title;
            changes.push({ op: op.name, summary, target });
            onEvent?.({ type: "change", op: op.name, summary, target });
          }
          if (mode === "read") {
            const json = JSON.stringify(result);
            if (json.length > RESULT_TEXT_CAP)
              return { truncated: true, text: json.slice(0, RESULT_TEXT_CAP) };
          }
          return result;
        },
      };
      const { registry } = await import("../api/registry.js");
      const ops = conciergeOps(registry);
      const allowedTools = conciergeAllowedTools(ops, principal, user, projectId);
      const { createConciergeMcpServer } = await import("../mcp/server.js");
      const mcpServer = createConciergeMcpServer({
        root: this.opts.root,
        principal,
        project: projectId,
        services: this.opts.services,
        authStore: this.opts.authStore,
        gate,
        listable: (op) => conciergeCanList(op, principal, user, projectId),
        instructions: CONCIERGE_MCP_INSTRUCTIONS,
        onCall: (info) => {
          toolCount++;
          void auditOperation(this.opts.root, {
            principal: info.principal,
            action: `concierge:mcp:${info.tool}`,
            via: "concierge",
            project: projectId,
            ok: info.ok,
            code: info.code,
            ms: info.ms,
            at: info.startedAt,
          });
        },
      });
      const prompt = buildConciergeMessage(text, resolved);
      onEvent?.({ type: "conversation", conversationId: conversation.id });
      let answerText = "";
      let usage: TokenUsage | null = null;
      let cumulative: TokenUsage | null = null;
      let stopReason: ConciergeAnswer["stopReason"] = "done";
      let sessionId = conversation.sessionId;
      let failure: ConciergeTurnError | null = null;
      try {
        const result = await this.opts.agent.turn({
          project,
          systemPrompt: CONCIERGE_SYSTEM_PROMPT,
          prompt,
          model: cfg.model,
          resumeSessionId: conversation.sessionId ?? undefined,
          resumeBaseline: conversation.baseline ?? undefined,
          maxTurns: cfg.maxTurns,
          maxBudgetUsd,
          timeoutMs: cfg.timeoutMs,
          mcpServer,
          mcpServerName: "boof",
          allowedTools,
          onEvent: (event) => {
            if (event.type === "text") answerText += event.text;
            onEvent?.(event);
          },
          signal,
        });
        answerText = result.text;
        usage = result.usage;
        cumulative = result.cumulative;
        sessionId = result.sessionId;
        stopReason = result.stopReason;
      } catch (err) {
        if (err instanceof ConciergeTurnError) {
          failure = err;
          usage = err.usage;
          sessionId = err.sessionId ?? sessionId;
        } else {
          throw err;
        }
      } finally {
        if (usage !== null) {
          try {
            await recordSpend({
              dataRoot: this.opts.root,
              projectId,
              tool: CONCIERGE_TOOL_ID,
              usage: { costUsd: usage.costUsd, known: usage.known },
              timezone: budgetTimeZone(settings),
              now: new Date(this.now()),
            });
          } catch (err) {
            console.error("could not record the assistant spend in the daily ledger:", err);
            await auditOperation(this.opts.root, {
              principal: user,
              action: "concierge:spend",
              via: "concierge",
              project: projectId,
              ok: false,
              code: "spend_failed",
              ms: Math.max(0, this.now() - startedAt),
              at: startedAt,
            });
          }
        }
        await this.store.update(projectId, conversation.id, (c) => {
          c.sessionId = sessionId;
          if (cumulative !== null && !failure) c.baseline = cumulative;
          else if (failure && usage?.known) {
            c.baseline = sumUsage([
              c.baseline ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, known: false },
              usage,
            ]);
          }
          if (usage?.known) c.spentUsd += usage.costUsd;
          else if (usage && !usage.known) c.unknownTurns++;
          c.messages++;
        });
        if (securitySettings(settings).audit.enabled) {
          try {
            await appendAuditLine(this.opts.root, {
              ts: new Date(this.now()).toISOString(),
              principal: user.id,
              kind: user.kind,
              action: "concierge:ask",
              via: "concierge",
              project: projectId,
              outcome: failure ? "error" : "ok",
              ...(failure ? { error: failure.kind } : {}),
              ms: Math.max(0, this.now() - startedAt),
              ...promptFingerprint(text),
              costUsd: usage?.known ? usage.costUsd : null,
              toolCount,
              pendingCount: messagePending,
            });
          } catch (err) {
            console.error("audit write failed", err);
          }
        }
      }
      const pending =
        (await this.store.get(projectId, conversation.id))?.changes
          .filter((c) => c.status === "pending" && Date.parse(c.expiresAt) > this.now())
          .map(toView) ?? [];
      if (failure) {
        if (failure.kind === "aborted")
          throw new OpError(499, "The assistant request was aborted", "internal");
        const status = failure.kind === "refused" ? 409 : failure.kind === "timeout" ? 504 : 502;
        const code = failure.kind === "refused" ? "concierge_unavailable" : "internal";
        const message = failure.kind === "timeout" ? "the assistant timed out" : failure.message;
        onEvent?.({ type: "error", code, message });
        throw new OpError(status, message, code);
      }
      const result: ConciergeAnswer = {
        conversationId: conversation.id,
        text: answerText,
        changes,
        pending,
        costUsd: usage?.known ? usage.costUsd : null,
        stopReason,
      };
      onEvent?.({ type: "done", answer: result });
      return result;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  async apply(
    user: Principal,
    projectId: string,
    changeId: string,
  ): Promise<{ change: PendingChangeView; result: unknown }> {
    const found = await this.store.findChange(projectId, user.id, changeId);
    if (!found) throw new OpError(404, "Pending change not found", "change_not_found");
    const conversation = await this.store.get(projectId, found.conversation.id);
    if (!conversation || conversation.owner !== user.id)
      throw new OpError(404, "Pending change not found", "change_not_found");
    const change = conversation.changes.find((c) => c.id === changeId);
    if (!change) throw new OpError(404, "Pending change not found", "change_not_found");
    if (change.status === "expired")
      throw new OpError(409, "Pending change expired", "change_expired");
    if (change.status !== "pending")
      throw new OpError(404, "Pending change not found", "change_not_found");
    const { getOp } = await import("../api/registry.js");
    const op = getOp(change.op);
    if (!op || !CONCIERGE_TOOLS[change.op])
      throw new OpError(404, "Pending change not found", "change_not_found");
    assertConfirmInput(change.op, change.input, projectId);
    const startedAt = this.now();
    const services = await this.opts.services.requireProject(projectId);
    const currentStamp = change.guard ? await this.readGuard(change.guard, services) : null;
    let claimedByMe = false;
    let stale = false;
    const claimed = await this.store.update(projectId, conversation.id, (c) => {
      const item = c.changes.find((x) => x.id === changeId);
      if (!item || item.status !== "pending" || Date.parse(item.expiresAt) <= this.now()) return;
      if (item.guard && currentStamp !== item.guard.stamp) {
        item.status = "failed";
        item.error = "change_stale";
        stale = true;
        return;
      }
      item.status = "applying";
      claimedByMe = true;
    });
    const claimedChange = claimed.changes.find((x) => x.id === changeId)!;
    if (claimedChange.status === "expired")
      throw new OpError(409, "Pending change expired", "change_expired");
    if (stale) throw new OpError(409, CHANGE_STALE_MESSAGE, "change_stale");
    if (!claimedByMe) {
      if (claimedChange.status === "applying")
        throw new OpError(404, "Pending change is already in progress.", "change_not_found");
      if (claimedChange.status === "applied")
        throw new OpError(404, "Pending change was already applied.", "change_not_found");
      throw new OpError(404, "Pending change not found", "change_not_found");
    }
    try {
      const result = await op.execute(
        {
          root: this.opts.root,
          principal: user,
          services: this.opts.services,
          authStore: this.opts.authStore,
          now: () => new Date(this.now()).toISOString(),
        },
        inputWithStaleGuard(op, change.input, change.guard),
      );
      const applied = await this.store.update(projectId, conversation.id, (c) => {
        const item = c.changes.find((x) => x.id === changeId);
        if (item?.status === "applying") item.status = "applied";
      });
      await auditOperation(this.opts.root, {
        principal: user,
        action: "concierge:apply",
        via: "concierge",
        project: projectId,
        ok: true,
        ms: Math.max(0, this.now() - startedAt),
        at: this.now(),
      });
      return { change: toView(applied.changes.find((x) => x.id === changeId)!), result };
    } catch (err) {
      const opErr = applyError(err);
      await this.store.update(projectId, conversation.id, (c) => {
        const item = c.changes.find((x) => x.id === changeId);
        if (item?.status === "applying") {
          item.status = "failed";
          item.error = opErr.code;
        }
      });
      await auditOperation(this.opts.root, {
        principal: user,
        action: "concierge:apply",
        via: "concierge",
        project: projectId,
        ok: false,
        code: opErr.code,
        ms: Math.max(0, this.now() - startedAt),
        at: this.now(),
      });
      throw opErr;
    }
  }

  async discard(user: Principal, projectId: string, changeId: string): Promise<PendingChangeView> {
    const found = await this.store.findChange(projectId, user.id, changeId);
    if (!found) throw new OpError(404, "Pending change not found", "change_not_found");
    const updated = await this.store.update(projectId, found.conversation.id, (c) => {
      if (c.owner !== user.id)
        throw new OpError(404, "Pending change not found", "change_not_found");
      const change = c.changes.find((x) => x.id === changeId);
      if (!change || change.status !== "pending")
        throw new OpError(404, "Pending change not found", "change_not_found");
      change.status = "discarded";
    });
    return toView(updated.changes.find((c) => c.id === changeId)!);
  }

  async reset(user: Principal, projectId: string): Promise<void> {
    await this.store.reset(projectId, user.id);
  }

  private checkRate(userId: string, limit: number): void {
    const cutoff = this.now() - 60_000;
    const recent = (this.rate.get(userId) ?? []).filter((at) => at > cutoff);
    if (recent.length >= limit)
      throw new OpError(
        429,
        "Too many requests; retry after the Retry-After header.",
        "rate_limited",
        { retryAfter: Math.max(1, Math.ceil((recent[0]! + 60_000 - this.now()) / 1000)) },
      );
    recent.push(this.now());
    this.rate.set(userId, recent);
  }

  /**
   * The given conversation when this owner still has it and it is inside `idleMs`.
   * An owned conversation past that window starts again through `store.current`.
   * Another owner's id, and an unknown id, stay `not_found`.
   */
  private async conversationFor(
    projectId: string,
    owner: string,
    conversationId: string | undefined,
    idleMs: number,
  ): Promise<ConciergeConversation> {
    if (!conversationId) return this.store.current(projectId, owner, idleMs);
    const conv = await this.store.get(projectId, conversationId);
    if (!conv || conv.owner !== owner)
      throw new OpError(404, "Conversation not found", "not_found");
    if (Date.parse(conv.updatedAt) + idleMs <= this.now())
      return this.store.current(projectId, owner, idleMs);
    return conv;
  }

  private async resolveContext(
    project: Project,
    projectService: Awaited<ReturnType<TaskService["requireProject"]>>,
    context?: z.output<typeof ConciergeContextSchema>,
  ): Promise<ResolvedContext> {
    const result: ResolvedContext = {
      project: { id: project.id, name: project.name },
      screen: context?.screen ?? "overview",
    };
    if (context?.taskId) {
      const task = await projectService.get(context.taskId).catch(() => null);
      if (task)
        result.task = {
          id: task.frontmatter.id,
          title: task.frontmatter.title,
          status: task.frontmatter.status,
        };
    }
    if (context?.planId) {
      const plan = await projectService.plans.get(context.planId).catch(() => null);
      if (plan) {
        result.plan = { id: plan.id, title: plan.title, status: plan.status };
        if (context.goalId) {
          const goal = plan.goals.find((g) => g.id === context.goalId);
          if (goal) result.goal = { id: goal.id, title: goal.title };
        }
      }
    }
    return result;
  }

  private async readGuard(
    guard: NonNullable<PendingChange["guard"]>,
    project: Awaited<ReturnType<TaskService["requireProject"]>>,
  ): Promise<string | null> {
    if (guard.kind === "task") return (await project.get(guard.id))?.frontmatter.updated ?? null;
    if (guard.kind === "plan") {
      try {
        return String((await project.plans.get(guard.id)).version);
      } catch {
        return null;
      }
    }
    if (guard.kind === "project") {
      try {
        return (await this.opts.services.getProject(guard.id)).updated;
      } catch {
        return null;
      }
    }
    try {
      return (await project.getEpic(guard.id)).updated;
    } catch {
      return null;
    }
  }
}

const CHANGE_STALE_MESSAGE = "The target changed since the assistant proposed this change.";

/** Conflict codes the operation raises for its own If-Match. Apply reports them as `change_stale`. */
const APPLY_STALE_CODES: ReadonlySet<string> = new Set([
  "plan_version_conflict",
  "task_modified",
  "epic_modified",
  "project_modified",
]);

function applyError(err: unknown): OpError {
  const opErr = err instanceof OpError ? err : new OpError(500, "Internal error", "internal");
  if (!APPLY_STALE_CODES.has(opErr.code)) return opErr;
  return new OpError(409, CHANGE_STALE_MESSAGE, "change_stale");
}

/**
 * Copy the proposal's stale-guard stamp into the op input when the op can enforce it.
 * The field is the one `rest.ifMatch` names, and only when it matches the guard kind
 * (`plan` → `expectedVersion`, `task` or `epic` → `expectedUpdated`). Anything else
 * is left unchanged, so a strict schema is never given an extra key.
 * The check before the claim stays; this makes the op refuse a write that lands after it.
 */
function inputWithStaleGuard(
  op: { input: z.ZodType; rest: { ifMatch?: "expectedVersion" | "expectedUpdated" } },
  input: Record<string, unknown>,
  guard: PendingChange["guard"],
): Record<string, unknown> {
  if (!guard || !(op.input instanceof z.ZodObject)) return input;
  const field = op.rest.ifMatch;
  const kindField = guard.kind === "plan" ? "expectedVersion" : "expectedUpdated";
  if (!field || field !== kindField) return input;
  const shape = op.input.shape as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(shape, field)) return input;
  if (field === "expectedUpdated") return { ...input, expectedUpdated: guard.stamp };
  const version = Number(guard.stamp);
  if (!Number.isInteger(version) || version < 1) return input;
  return { ...input, expectedVersion: version };
}

function toView(change: PendingChange): PendingChangeView {
  return {
    id: change.id,
    op: change.op,
    title: change.title,
    details: change.details,
    destructive: change.destructive,
    ...(change.blocked ? { blocked: change.blocked } : {}),
    ...(change.error ? { error: change.error } : {}),
    reason: change.reason,
    status: change.status,
    expiresAt: change.expiresAt,
  };
}
/** What the console shows again after a reload: waiting and running changes, and recent failures. */
function statusViews(conversation: ConciergeConversation): PendingChangeView[] {
  const failed = conversation.changes.filter((c) => c.status === "failed").slice(-3);
  return conversation.changes
    .filter((c) => c.status === "pending" || c.status === "applying" || failed.includes(c))
    .map(toView);
}
function targetOf(
  op: string,
  value: unknown,
): { kind: "task" | "plan" | "epic"; id: string } | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    op.startsWith("tasks.") &&
    item.frontmatter &&
    typeof item.frontmatter === "object" &&
    typeof (item.frontmatter as Record<string, unknown>).id === "string"
  )
    return { kind: "task", id: (item.frontmatter as Record<string, string>).id };
  if (op.startsWith("plans.") && typeof item.id === "string") return { kind: "plan", id: item.id };
  if (op.startsWith("epics.") && typeof item.id === "string") return { kind: "epic", id: item.id };
  return null;
}
