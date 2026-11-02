import type { Scope } from "@boof-runner/shared/schema";
import type { PublicClient, Whoami } from "../api-types.js";

/** What each scope allows, in the words the create form shows. A Record keeps the list complete. */
export const SCOPE_TEXT: Record<Scope, string> = {
  "projects:read": "See projects and their token usage.",
  "projects:write": "Add, edit, archive and delete projects.",
  "plans:read": "Read and export plans and goals.",
  "plans:write": "Create, edit, import and sync plans and goals.",
  "tasks:read": "Read tasks, logs, diffs, questions and command templates.",
  "tasks:write": "Create, edit, queue, retry, archive and delete tasks; answer questions.",
  "tasks:control": "Stop a running task or steer it.",
  "settings:read": "Read settings, models, tool health and the runner status.",
  "settings:write": "Change settings and command templates.",
  "runner:control": "Turn the runner on or off; pause and resume projects.",
  "auth:admin": "Create, rotate and revoke API keys within its own reach.",
  admin: "Everything, including webhooks.",
};

export const SCOPE_ORDER: readonly Scope[] = [
  "projects:read",
  "projects:write",
  "plans:read",
  "plans:write",
  "tasks:read",
  "tasks:write",
  "tasks:control",
  "settings:read",
  "settings:write",
  "runner:control",
  "auth:admin",
  "admin",
];

/** The scopes of the README's harness example. */
export const HARNESS_SCOPES: readonly Scope[] = [
  "projects:read",
  "projects:write",
  "plans:read",
  "plans:write",
  "tasks:read",
  "tasks:write",
];

export function clientState(c: PublicClient, now: number): "active" | "revoked" | "expired" {
  if (c.revokedAt) return "revoked";
  if (c.expiresAt && Date.parse(c.expiresAt) <= now) return "expired";
  return "active";
}

/** Active keys first, newest first within each state. */
export function sortClients(cs: PublicClient[], now: number): PublicClient[] {
  const rank = (c: PublicClient) => (clientState(c, now) === "active" ? 0 : 1);
  return [...cs].sort(
    (a, b) => rank(a) - rank(b) || (a.created < b.created ? 1 : a.created > b.created ? -1 : 0),
  );
}

export const EXPIRY_CHOICES = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "365d", label: "1 year" },
  { value: "", label: "Never" },
] as const;

export interface ClientFormValues {
  name: string;
  kind: "harness" | "mcp" | "cli";
  scopes: Scope[];
  projects: "*" | string[];
  trust: "trusted" | "review";
  expiresIn: string;
}

export const NEW_CLIENT: ClientFormValues = {
  name: "",
  kind: "harness",
  scopes: ["tasks:read"],
  projects: "*",
  trust: "review",
  expiresIn: "30d",
};

/** The scopes this browser's key can hand out; "all" when the server will be the judge. */
export function heldScopes(w: Whoami | null): ReadonlySet<Scope> | "all" {
  if (!w || w.principal.kind === "local" || w.principal.scopes.includes("admin")) return "all";
  return new Set(w.principal.scopes);
}

export function clientFormProblems(
  v: ClientFormValues,
  held: ReadonlySet<Scope> | "all",
): string[] {
  const out: string[] = [];
  if (!v.name.trim()) out.push("Name the key.");
  if (v.scopes.length === 0) out.push("Choose at least one scope.");
  if (v.projects !== "*" && v.projects.length === 0)
    out.push("Choose at least one project, or allow every project.");
  if (held !== "all") {
    const missing = v.scopes.filter((s) => !held.has(s));
    if (missing.length > 0) out.push(`Your own key cannot grant: ${missing.join(", ")}.`);
  }
  return out;
}

export function toCreateClientInput(v: ClientFormValues) {
  return {
    name: v.name.trim(),
    kind: v.kind,
    scopes: v.scopes.includes("admin") ? ["admin"] : v.scopes,
    projects: v.projects,
    trust: v.trust,
    ...(v.expiresIn ? { expiresIn: v.expiresIn } : {}),
  };
}

/** True when `c` is the key the calling browser uses. */
export function isOwnKey(c: PublicClient, w: Whoami | null): boolean {
  return !!w && w.principal.kind === "client" && w.principal.id === c.id;
}
