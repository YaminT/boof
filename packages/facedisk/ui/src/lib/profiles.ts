import type {
  OrchestrationProfile,
  Project,
  RoleAssignment,
  Settings,
  SettingsPatch,
} from "@boof/heart/schema";
import { sameValue, type PageModel, type PageValues } from "./settings-draft.js";

export type ProfileRoleName = "planner" | "developer" | "observer" | "reviewer";

/** The owner's words for each role: advisor is the planner, the observer is the second reviewer. */
export const PROFILE_ROLES: readonly { role: ProfileRoleName; label: string; canBeOff: boolean }[] =
  [
    { role: "planner", label: "Advisor", canBeOff: true },
    { role: "developer", label: "Developer", canBeOff: false },
    { role: "reviewer", label: "Reviewer", canBeOff: true },
    { role: "observer", label: "Second reviewer", canBeOff: true },
  ];

export type ProfileTemplate = "current" | "developer-only";

export interface ProfilesGlobal {
  profiles: OrchestrationProfile[];
  activeProfile: string | null;
}
export type ProfilesValues = PageValues<ProfilesGlobal, Record<string, never>>;

/** The most profiles settings accept (the schema's limit; the UI may import only types from heart). */
export const MAX_PROFILES = 20;
const NAME_MAX = 60;

/** A kebab-case id from a name, unique among `taken`. */
export function uniqueProfileId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "profile";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

/** A name not used by another profile: "X", then "X 2", "X 3"… (within the name limit). */
export function uniqueProfileName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  const base = name.trim().slice(0, NAME_MAX - 4) || "Profile";
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A new profile from a template; it is not added to any list yet. */
export function newProfile(
  template: ProfileTemplate,
  settings: Pick<Settings, "roles">,
  existing: readonly OrchestrationProfile[],
): OrchestrationProfile {
  const r = settings.roles;
  const name = uniqueProfileName(
    template === "current" ? "Current roles" : "Developer only",
    existing.map((p) => p.name),
  );
  return {
    id: uniqueProfileId(
      name,
      existing.map((p) => p.id),
    ),
    name,
    roles:
      template === "current"
        ? {
            planner: { ...r.planner },
            developer: { ...r.developer },
            observer: r.observer ? { ...r.observer } : null,
            reviewer: { ...r.reviewer },
          }
        : { planner: null, developer: { ...r.developer }, observer: null, reviewer: null },
  };
}

export function duplicateProfile(
  p: OrchestrationProfile,
  existing: readonly OrchestrationProfile[],
): OrchestrationProfile {
  const name = uniqueProfileName(
    `${p.name} copy`,
    existing.map((x) => x.name),
  );
  return {
    ...structuredClone(p),
    name,
    id: uniqueProfileId(
      name,
      existing.map((x) => x.id),
    ),
  };
}

/** Sets one role of one profile; `null` turns the role off. The id never changes. */
export function setProfileRole(
  profiles: OrchestrationProfile[],
  id: string,
  role: ProfileRoleName,
  value: RoleAssignment | null,
): OrchestrationProfile[] {
  return profiles.map((p) => (p.id === id ? { ...p, roles: { ...p.roles, [role]: value } } : p));
}

export function renameProfile(
  profiles: OrchestrationProfile[],
  id: string,
  name: string,
): OrchestrationProfile[] {
  return profiles.map((p) => (p.id === id ? { ...p, name } : p));
}

/** Projects that pick this profile. */
export function projectsUsing(projects: readonly Project[], id: string): Project[] {
  return projects.filter((p) => p.profile === id);
}

export type DeleteOutcome =
  { ok: true; values: ProfilesGlobal } | { ok: false; message: string; projects: string[] };

/** Delete a profile; refused (like the server's `profile_in_use`) while a project uses it. */
export function deleteProfile(
  values: ProfilesGlobal,
  id: string,
  projects: readonly Project[],
): DeleteOutcome {
  const using = projectsUsing(projects, id);
  if (using.length > 0) {
    const names = using.map((p) => p.name);
    return {
      ok: false,
      projects: names,
      message: `Used by ${names.join(", ")}. Choose another profile there first.`,
    };
  }
  return {
    ok: true,
    values: {
      profiles: values.profiles.filter((p) => p.id !== id),
      activeProfile: values.activeProfile === id ? null : values.activeProfile,
    },
  };
}

/** The text of one role in a list row: "developer claude-code haiku", or "off". */
export function roleSummary(a: RoleAssignment | null): string {
  if (!a) return "off";
  return a.model ? `${a.tool} ${a.model}` : `${a.tool} (default model)`;
}

export function profileSummary(p: OrchestrationProfile): string {
  return PROFILE_ROLES.filter(({ role }) => role !== "observer" || p.roles.observer)
    .map(({ role, label }) => `${label}: ${roleSummary(p.roles[role])}`)
    .join(" · ");
}

/** Everything that stops Save. `known` lists the tool ids this install has (empty: do not check). */
export function profileProblems(g: ProfilesGlobal, known: readonly string[] = []): string[] {
  const out: string[] = [];
  if (g.profiles.length > MAX_PROFILES) out.push(`Use at most ${MAX_PROFILES} profiles.`);
  const names = new Set<string>();
  for (const p of g.profiles) {
    const name = p.name.trim();
    if (!name) out.push("Give every profile a name.");
    else if (name.length > NAME_MAX)
      out.push(`"${name.slice(0, 20)}…" is longer than ${NAME_MAX}.`);
    else if (names.has(name.toLowerCase())) out.push(`Two profiles are called "${name}".`);
    names.add(name.toLowerCase());
    for (const { role, label } of PROFILE_ROLES) {
      const a = p.roles[role];
      if (!a) continue;
      if (known.length > 0 && !known.includes(a.tool))
        out.push(`${name || "A profile"}: ${label} uses ${a.tool}, which does not exist.`);
    }
  }
  if (g.activeProfile && !g.profiles.some((p) => p.id === g.activeProfile))
    out.push("The profile in use does not exist.");
  return out;
}

/** Settings › Profiles: the list and the active one; saved whole (`profiles` is replaced whole). */
export const profilesPage: PageModel<ProfilesValues> = {
  values: (s) => ({
    global: { profiles: s.profiles ?? [], activeProfile: s.activeProfile ?? null },
    project: {},
  }),
  problems: (v) => profileProblems(v.global),
  patches: (form, base) => {
    const settings: SettingsPatch = {};
    if (!sameValue(form.global.profiles, base.global.profiles))
      settings.profiles = form.global.profiles;
    if (form.global.activeProfile !== base.global.activeProfile)
      settings.activeProfile = form.global.activeProfile;
    return Object.keys(settings).length > 0 ? { settings } : {};
  },
};
