import { useEffect, useMemo, useState } from "react";
import type { OrchestrationProfile, Project, RoleAssignment, Settings } from "@boof/heart/schema";
import { MAX_PROFILES } from "@boof/heart/schema";
import { api } from "../api.js";
import type { ToolModelDetails } from "../api-types.js";
import { isDesktop } from "../desktop.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import {
  deleteProfile,
  duplicateProfile,
  newProfile,
  profileSummary,
  PROFILE_ROLES,
  renameProfile,
  setProfileRole,
  type ProfileRoleName,
  type ProfileTemplate,
  type ProfilesValues,
} from "../lib/profiles.js";
import {
  roleModelLabel,
  roleModelOptions,
  roleToolAssignment,
  toolOptionLabel,
} from "../lib/settings-agents.js";

const h2 = "m-0 text-[length:var(--text-section)] font-semibold";
const help = "text-[length:var(--text-row)] font-normal text-ink-muted";

/** One role of a profile: a tool select (with "Off" when the role may be off) and a model select. */
function ProfileRoleSelects({
  label,
  value,
  canBeOff,
  tools,
  models,
  toolLabel,
  onChange,
}: {
  label: string;
  value: RoleAssignment | null;
  canBeOff: boolean;
  tools: string[];
  models: Record<string, string[]>;
  toolLabel: (tool: string) => string;
  onChange: (next: RoleAssignment | null) => void;
}) {
  // A tool this install does not list stays in the select, so a saved choice is never changed silently.
  const options = value && !tools.includes(value.tool) ? [...tools, value.tool] : tools;
  return (
    <div className="flex flex-col gap-1.5">
      <NativeSelect
        aria-label={`${label} tool`}
        className="w-full"
        value={value?.tool ?? ""}
        onChange={(e) => {
          const tool = e.target.value;
          onChange(tool ? roleToolAssignment(tool, models) : null);
        }}
      >
        {canBeOff && <option value="">Off</option>}
        {options.map((t) => (
          <option key={t} value={t}>
            {toolLabel(t)}
          </option>
        ))}
      </NativeSelect>
      {value && (
        <NativeSelect
          aria-label={`${label} model`}
          className="w-full"
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        >
          {roleModelOptions(value.tool, models, value.model).map((m) => (
            <option key={m} value={m}>
              {roleModelLabel(value.tool, m)}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}

/** Settings › Profiles: named sets of roles (advisor, developer, reviewer, second reviewer). */
export function ProfilesPage({
  form,
  set,
  settings,
  projects,
}: {
  form: ProfilesValues;
  set: (update: (v: ProfilesValues) => ProfilesValues) => void;
  settings: Settings;
  /** Projects, to refuse deleting a profile one of them uses. */
  projects: Project[];
}) {
  const { profiles, activeProfile } = form.global;
  const setG = (patch: Partial<ProfilesValues["global"]>) =>
    set((v) => ({ ...v, global: { ...v.global, ...patch } }));
  const setProfiles = (next: OrchestrationProfile[]) => setG({ profiles: next });

  const [details, setDetails] = useState<Record<string, ToolModelDetails> | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .modelDetails()
      .then((d) => live && setDetails(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const unavailable = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [tool, info] of Object.entries(details ?? {}))
      if (info.unavailableReason) out[tool] = info.unavailableReason;
    return out;
  }, [details]);
  const env = useMemo(() => ({ isDesktop, unavailable }), [unavailable]);

  const models = useMemo(() => {
    const out: Record<string, string[]> = {};
    const add = (tool: string, list: string[]) => {
      out[tool] = [...new Set([...(out[tool] ?? []), ...list])];
    };
    for (const [tool, list] of Object.entries(settings.models ?? {})) add(tool, list);
    for (const [tool, info] of Object.entries(details ?? {}))
      add(
        tool,
        info.models.map((m) => m.id),
      );
    return out;
  }, [settings.models, details]);
  // Tools to choose from: the ones this install lists and can run.
  const tools = useMemo(
    () => Object.keys(models).filter((t) => !unavailable[t]),
    [models, unavailable],
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null);
  const atLimit = profiles.length >= MAX_PROFILES;

  const add = (template: ProfileTemplate) => {
    const p = newProfile(template, settings, profiles);
    setProfiles([...profiles, p]);
    setEditing(p.id);
    setRefused(null);
  };
  const duplicate = (p: OrchestrationProfile) => {
    const copy = duplicateProfile(p, profiles);
    setProfiles([...profiles, copy]);
    setEditing(copy.id);
    setRefused(null);
  };
  const remove = (p: OrchestrationProfile) => {
    const out = deleteProfile(form.global, p.id, projects);
    if (!out.ok) {
      setRefused({ id: p.id, message: out.message });
      return;
    }
    setRefused(null);
    if (editing === p.id) setEditing(null);
    setG(out.values);
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className={h2}>Profiles</h2>
        <p className={`m-0 ${help}`}>
          A profile is a set of roles: the advisor plans and answers questions, the developer does
          the work, the reviewer and the second reviewer check it. Switch a role off to skip it. The
          profile in use applies to tasks that start after you save; a running task keeps its roles.
          Without a profile, the roles on the Agents page apply.
        </p>
      </section>

      {profiles.length === 0 ? (
        <p className={`m-0 ${help}`}>No profiles yet. The roles on the Agents page apply.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {profiles.map((p) => {
            const active = p.id === activeProfile;
            const open = editing === p.id;
            return (
              <li key={p.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <strong className="min-w-0 flex-1 break-words text-[length:var(--text-body)]">
                    {p.name}
                    {active && (
                      <span className="ml-2 rounded-full border border-accent-brand px-2 py-0.5 text-[length:var(--text-row)] font-normal">
                        In use
                      </span>
                    )}
                  </strong>
                  <span className="flex flex-wrap gap-2">
                    {!active && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setG({ activeProfile: p.id })}
                      >
                        Use
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={open}
                      onClick={() => setEditing(open ? null : p.id)}
                    >
                      {open ? "Done" : "Edit"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={atLimit}
                      onClick={() => duplicate(p)}
                    >
                      Duplicate
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => remove(p)}>
                      Delete
                    </Button>
                  </span>
                </div>
                <p className={`m-0 mt-1 ${help}`}>{profileSummary(p)}</p>
                {refused?.id === p.id && (
                  <p role="alert" className="m-0 mt-2 text-[length:var(--text-row)] text-attention">
                    Cannot delete “{p.name}”. {refused.message}
                  </p>
                )}
                {open && (
                  <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                    <label className="flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium">
                      Name
                      <Input
                        className="mt-0 font-normal"
                        value={p.name}
                        maxLength={60}
                        onChange={(e) => setProfiles(renameProfile(profiles, p.id, e.target.value))}
                      />
                    </label>
                    {PROFILE_ROLES.map(({ role, label, canBeOff }) => (
                      <div key={role} className="flex flex-col gap-1.5">
                        <span className="text-[length:var(--text-body)] font-medium">{label}</span>
                        <ProfileRoleSelects
                          label={`${p.name} ${label}`}
                          value={p.roles[role as ProfileRoleName]}
                          canBeOff={canBeOff}
                          tools={tools}
                          models={models}
                          toolLabel={(t) => toolOptionLabel(t, env)}
                          onChange={(next) =>
                            setProfiles(setProfileRole(profiles, p.id, role, next))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <h2 className={h2}>New profile</h2>
        <span className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={atLimit} onClick={() => add("current")}>
            From the current roles
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={atLimit}
            onClick={() => add("developer-only")}
          >
            Developer only
          </Button>
        </span>
        <span className={help}>
          {atLimit
            ? `You have ${MAX_PROFILES} profiles, the most there can be.`
            : "Developer only runs the task with no advisor and no review; it ends as done. Press Save changes to keep your edits."}
        </span>
        {activeProfile && (
          <span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setG({ activeProfile: null })}
            >
              Stop using a profile
            </Button>
          </span>
        )}
      </section>
    </div>
  );
}
