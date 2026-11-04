import type { Scope } from "@boof/heart/schema";
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
  /** The projects the caller is limited to, or null when it reaches every project. */
  reach: string[] | null = null,
): string[] {
  const out: string[] = [];
  if (!v.name.trim()) out.push("Name the key.");
  if (v.scopes.length === 0) out.push("Choose at least one scope.");
  if (v.projects !== "*" && v.projects.length === 0)
    out.push("Choose at least one project, or allow every project.");
  if (reach) {
    if (v.projects === "*") out.push("Your own key cannot grant every project.");
    else {
      const outside = v.projects.filter((p) => !reach.includes(p));
      if (outside.length > 0) out.push(`Your own key cannot reach: ${outside.join(", ")}.`);
    }
  }
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

const DAY = 86_400_000;
const durationMs = (v: string): number => (/^\d+d$/.test(v) ? Number(v.slice(0, -1)) * DAY : 0);

export interface ExpiryChoice {
  value: string;
  label: string;
  disabled: boolean;
  note?: string;
}

/**
 * The expiry choices this caller may use. A key cannot outlive the key that creates it, so for a
 * caller whose key expires, the choices beyond that are disabled and "Never" means "when your key
 * expires".
 */
export function expiryChoices(w: Whoami | null, now: number): ExpiryChoice[] {
  const cap = w?.principal.kind === "client" ? w.principal.expiresAt : undefined;
  const capMs = cap ? Date.parse(cap) - now : null;
  return EXPIRY_CHOICES.map((c) => {
    if (capMs === null) return { value: c.value, label: c.label, disabled: false };
    if (c.value === "") {
      return {
        value: "",
        label: `When your key expires (${new Date(cap!).toLocaleDateString()})`,
        disabled: false,
      };
    }
    const over = durationMs(c.value) > capMs;
    return {
      value: c.value,
      label: c.label,
      disabled: over,
      ...(over ? { note: "Longer than your own key lasts." } : {}),
    };
  });
}

/** The projects the caller is limited to, or null when it may reach every project. */
export function callerProjects(w: Whoami | null): string[] | null {
  return w && w.principal.kind === "client" && w.principal.projects !== "*"
    ? w.principal.projects
    : null;
}

/** A new-key form that starts on choices this caller can actually make. */
export function initialClient(w: Whoami | null, now: number): ClientFormValues {
  const projects = callerProjects(w);
  const firstOpen = expiryChoices(w, now).find((c) => !c.disabled && c.value !== "");
  const keep = expiryChoices(w, now).find((c) => c.value === NEW_CLIENT.expiresIn && !c.disabled);
  return {
    ...NEW_CLIENT,
    ...(projects ? { projects: [...projects] } : {}),
    expiresIn: keep ? keep.value : (firstOpen?.value ?? ""),
    trust: w?.principal.trust === "review" ? "review" : NEW_CLIENT.trust,
  };
}
