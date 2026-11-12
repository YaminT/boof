import { authorize, authorizeProject, hasScope, type Principal, type Scope } from "@boof/heart";
import type { AuthStore } from "@boof/heart";
import type { AnyOperation } from "../api/index.js";
import { OpError } from "../api/errors.js";
import { containsSecret } from "./preview.js";

export type ConciergeToolMode = "read" | "write" | "confirm";

export const CONCIERGE_TOOLS: Readonly<Record<string, ConciergeToolMode>> = Object.freeze({
  "projects.get": "read",
  "plans.list": "read",
  "plans.get": "read",
  "tasks.list": "read",
  "tasks.get": "read",
  "tasks.liveLog": "read",
  "epics.list": "read",
  "epics.get": "read",
  "usage.budget": "read",
  "commands.list": "read",
  "tasks.create": "write",
  "tasks.update": "write",
  "tasks.move": "write",
  "epics.create": "write",
  "epics.update": "write",
  "plans.create": "write",
  "plans.update": "write",
  "plans.upsertGoal": "write",
  "plans.reorderGoals": "write",
  "plans.setGoalStatus": "write",
  "tasks.delete": "confirm",
  "tasks.archive": "confirm",
  "tasks.queue": "confirm",
  "epics.delete": "confirm",
  "plans.removeGoal": "confirm",
  "plans.replaceGoals": "confirm",
  "projects.update": "confirm",
});

/**
 * Whether this call is a confirm-class change. Besides the tools listed as `confirm`, setting a
 * plan to `active` is one: activating creates one task per goal, so the user applies it.
 */
export function isConfirmCall(opName: string, input: Record<string, unknown>): boolean {
  if (CONCIERGE_TOOLS[opName] === "confirm") return true;
  return opName === "plans.update" && input.status === "active";
}

export const CONCIERGE_SCOPES: readonly Scope[] = [
  "projects:read",
  "plans:read",
  "plans:write",
  "tasks:read",
  "tasks:write",
];

/** The most a proposed description may hold, so the preview can show every character of it. */
export const BRIEF_MAX_CHARS = 4_000;
export const BRIEF_MAX_LINES = 60;

export const RESULT_TEXT_CAP = 20_000;

/**
 * Deliberately absent: tasks.diff reads the git worktree outside the data root; plans.import reads
 * repository files; tasks.wait and plans.wait are long polls; tasks.stop and tasks.inject need
 * tasks:control; tasks.answers, tasks.retry, tasks.skip and plans.sync start or advance work
 * without a human. Project writes other than the description change (see `assertConfirmInput`),
 * settings, accounts, runner, auth, webhooks, command writes and attachments are also excluded.
 */
export function conciergeOps(registry: readonly AnyOperation[]): AnyOperation[] {
  return registry.filter((op) => Object.hasOwn(CONCIERGE_TOOLS, op.name));
}

/** Line endings are normalised (CRLF to LF) before the text is checked, previewed and stored. */
export function normalizeConfirmInput(
  opName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (opName !== "projects.update" || typeof input.brief !== "string") return input;
  return { ...input, brief: input.brief.replace(/\r\n/g, "\n") };
}

/**
 * A confirm tool may be narrower than its operation. `projects.update` is offered for one change only:
 * the description (`brief`) of the project the conversation is about. Anything else is refused
 * before a pending change exists, and again at apply (the stored input is checked once more).
 */
export function assertConfirmInput(
  opName: string,
  input: Record<string, unknown>,
  projectId: string,
): void {
  if (opName !== "projects.update") return;
  if (input.projectId !== projectId)
    throw new OpError(
      403,
      "The assistant can only change the current project",
      "forbidden_project",
    );
  const extra = Object.keys(input).filter(
    (key) => key !== "projectId" && key !== "brief" && input[key] !== undefined,
  );
  if (extra.length > 0 || typeof input.brief !== "string")
    throw new OpError(
      403,
      "The assistant can only propose a new description for the project",
      "forbidden_scope",
    );
  const brief = input.brief;
  assertBriefText(brief);
  if (brief.length > BRIEF_MAX_CHARS || brief.split("\n").length > BRIEF_MAX_LINES)
    throw new OpError(
      400,
      `The description is too long to review (at most ${BRIEF_MAX_CHARS} characters and ${BRIEF_MAX_LINES} lines); shorten it`,
      "invalid_input",
    );
}

const VISIBLE_SPACES = /[\u00a0\u3000]/g;
const JOINERS = /[\u200c\u200d]/;
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Characters the preview cannot show are refused; ZWJ/ZWNJ only singly between two visible characters. */
function assertBriefText(brief: string): void {
  const chars = Array.from(brief);
  const bad = chars.some((ch, i) => {
    if (ch === "\n" || ch === "\t" || ch === " " || ch === "\u00ad") return false;
    if (VISIBLE_SPACES.test(ch)) {
      VISIBLE_SPACES.lastIndex = 0;
      return false;
    }
    if (JOINERS.test(ch)) {
      const before = chars[i - 1];
      const after = chars[i + 1];
      return !(before && after && !/[\s\p{Cf}]/u.test(before) && !/[\s\p{Cf}]/u.test(after));
    }
    return UNSHOWABLE.test(ch);
  });
  if (bad)
    throw new OpError(
      400,
      "The description holds control, format or unusual space characters the preview cannot show; remove them",
      "invalid_input",
    );
  if (containsSecret(brief))
    throw new OpError(
      400,
      "The description looks like it contains a secret or an encoded blob; remove secrets from the description",
      "invalid_input",
    );
}

/** Whether `user` may apply `op` in `projectId`: the rule the assistant's confirm tools follow. */
export function userMayApply(op: AnyOperation, user: Principal, projectId: string): boolean {
  // A review-trust client may not change a project's description (`assertMayChangeProject`).
  if (op.name === "projects.update" && user.kind === "client" && user.trust === "review")
    return false;
  return (
    (op.scopes.length === 0 || op.scopes.some((scope) => authorize(user, scope))) &&
    authorizeProject(user, projectId)
  );
}

export function conciergePrincipal(user: Principal, projectId: string): Principal {
  const scopes = CONCIERGE_SCOPES.filter((scope) => hasScope(user, scope));
  const projects = authorizeProject(user, projectId) ? new Set([projectId]) : new Set<string>();
  return {
    id: `concierge-${user.id}`,
    name: `Assistant for ${user.name}`,
    kind: "client",
    clientKind: "mcp",
    trust: "review",
    alwaysReview: true,
    scopes: new Set(scopes),
    projects,
  };
}

/** Refuse legacy stored identities that collide with this in-memory principal. */
export async function assertConciergeIdAvailable(
  user: Principal,
  authStore: AuthStore,
): Promise<void> {
  const id = `concierge-${user.id}`;
  if ((await authStore.list()).some((client) => client.id === id)) {
    throw new Error(
      `clients.json holds a client with the reserved id ${id} (made before the id was reserved); ` +
        "remove its entry from auth/clients.json before using the concierge",
    );
  }
}

export function conciergeCanList(
  op: AnyOperation,
  principal: Principal,
  user: Principal,
  projectId: string,
): boolean {
  if (CONCIERGE_TOOLS[op.name] === "confirm") return userMayApply(op, user, projectId);
  return op.scopes.length === 0 || op.scopes.some((scope) => authorize(principal, scope));
}

/**
 * Tools the model is told about. Read and write tools follow the assistant's own principal; confirm
 * tools never run under it (they are applied with the user's rights), so they follow the user's.
 */
export function conciergeAllowedTools(
  ops: readonly AnyOperation[],
  principal: Principal,
  user: Principal,
  projectId: string,
): string[] {
  return ops
    .filter((op) => conciergeCanList(op, principal, user, projectId))
    .map((op) => `mcp__boof__${op.mcp.name}`);
}
