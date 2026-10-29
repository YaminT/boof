import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import { Textarea } from "@/ui/textarea";
import { api, type TaskView } from "../api.js";
import type { CommandTemplate } from "../api-types.js";
import { act } from "../lib/act.js";
import { relativeTime } from "../lib/time.js";
import { TaskAttachments } from "./TaskAttachments.js";

interface Values {
  title: string;
  prompt: string;
  priority: number;
  runs: number;
  labels: string;
  command: string | null;
}

const EMPTY: Values = { title: "", prompt: "", priority: 50, runs: 1, labels: "", command: null };

const toValues = (t: TaskView): Values => ({
  title: t.frontmatter.title,
  prompt: t.body.prompt,
  priority: t.frontmatter.priority,
  runs: t.frontmatter.runs,
  labels: t.frontmatter.labels.join(", "),
  command: t.frontmatter.command,
});

const parseLabels = (s: string) =>
  s
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

/** Equal ignoring how the labels are spaced. */
const key = (v: Values) => JSON.stringify({ ...v, labels: parseLabels(v.labels) });

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-0 flex flex-col gap-1 text-[length:var(--text-row)] font-normal text-ink">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="font-normal text-ink-muted">{hint}</span>}
    </label>
  );
}

/** What the page reads from the form: unsaved edits, and a way to save them (with a status). */
export interface FormHandle {
  dirty: boolean;
  save(status?: "pending"): Promise<boolean>;
}

/**
 * The task's fields. They are edited locally and compared with the last server value; when the
 * server copy changes while they are dirty the edits are kept and the user chooses to reload.
 * `task` is null for a new task.
 */
export function TaskForm({
  pid,
  task,
  locked,
  reload,
  onCreated,
  handle,
}: {
  pid: string;
  task: TaskView | null;
  locked: boolean;
  reload: () => Promise<void>;
  /** A new task was saved (or got its first attachment) under this id. */
  onCreated: (id: string) => void;
  handle?: RefObject<FormHandle | null>;
}) {
  const isNew = task === null;
  const server = useMemo(() => (task ? toValues(task) : EMPTY), [task]);
  const [base, setBase] = useState(server);
  const [form, setForm] = useState(server);
  const [elsewhere, setElsewhere] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [commands, setCommands] = useState<CommandTemplate[]>([]);
  const busy = useRef(false);
  const [isBusy, setBusy] = useState(false);
  const createdId = useRef<string | null>(null);
  const dirty = key(form) !== key(base);

  useEffect(() => {
    void api
      .listCommands()
      .then(setCommands)
      .catch(() => {});
  }, []);

  // The server copy moved: follow it while the form is clean, otherwise keep the edits and say so.
  useEffect(() => {
    if (!task || key(server) === key(base)) return;
    if (dirty) setElsewhere(true);
    else {
      setBase(server);
      setForm(server);
    }
  }, [server]);

  // A run started: the form is locked, so show the server copy, never unsaved values.
  useEffect(() => {
    if (!locked) return;
    setBase(server);
    setForm(server);
    setElsewhere(false);
  }, [locked]);

  // Keep "Saved 2m ago" current.
  useEffect(() => {
    if (!savedAt) return;
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [savedAt]);

  const set = <K extends keyof Values>(k: K, v: Values[K]) => setForm((f) => ({ ...f, [k]: v }));
  const payload = () => ({
    title: form.title.trim(),
    prompt: form.prompt,
    priority: form.priority,
    runs: form.runs,
    labels: parseLabels(form.labels),
    command: form.command,
  });

  const save = async (status?: "pending"): Promise<boolean> => {
    if (!task || busy.current) return false;
    busy.current = true;
    setBusy(true);
    try {
      const ok = await act(
        () =>
          api.updateTask(pid, task.frontmatter.id, { ...payload(), ...(status ? { status } : {}) }),
        { failure: "Could not save" },
      );
      if (!ok) return false;
      setBase(form);
      setElsewhere(false);
      setSavedAt(new Date().toISOString());
      await reload();
      return true;
    } finally {
      busy.current = false;
      setBusy(false);
    }
  };
  if (handle) handle.current = { dirty, save };

  const create = async (status: "draft" | "pending") => {
    if (busy.current) return;
    busy.current = true;
    setBusy(true);
    const made = await act(
      () =>
        createdId.current
          ? api.updateTask(pid, createdId.current, { ...payload(), status })
          : api.createTask(pid, { ...payload(), status }),
      { success: status === "pending" ? "Queued" : "Saved as draft", failure: "Could not save" },
    );
    if (made) onCreated(made.frontmatter.id);
    else {
      busy.current = false;
      setBusy(false);
    }
  };

  // A new task gets a draft the first time a file is attached, so there is a task to attach to.
  const ensureId = async () => {
    if (task) return task.frontmatter.id;
    if (createdId.current) return createdId.current;
    const made = await api.createTask(pid, {
      ...payload(),
      title: form.title.trim() || "Untitled task",
      status: "draft",
    });
    createdId.current = made.frontmatter.id;
    return made.frontmatter.id;
  };

  const discard = () => {
    setBase(server);
    setForm(server);
    setElsewhere(false);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isNew && dirty && !locked) void save();
      }}
    >
      {locked && (
        <p className="m-0 rounded-md border border-line bg-surface px-3 py-2 text-[length:var(--text-row)] text-ink-muted">
          Editing is locked while the task runs. Stop it or wait for it to finish.
        </p>
      )}
      {elsewhere && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-attention/40 bg-surface px-3 py-2 text-[length:var(--text-row)] text-attention"
        >
          <span>This task changed elsewhere.</span>
          <Button type="button" variant="outline" size="xs" onClick={discard}>
            Reload
          </Button>
        </div>
      )}
      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <Field label="Title">
          <Input
            className="mt-0 font-normal"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Task title"
          />
        </Field>
        <Field label="Labels" hint="Separate with commas.">
          <Input
            className="mt-0 font-normal"
            value={form.labels}
            onChange={(e) => set("labels", e.target.value)}
            placeholder="backend, auth"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Input
              className="mt-0 font-normal"
              type="number"
              value={form.priority}
              onChange={(e) => set("priority", Number(e.target.value))}
            />
          </Field>
          <Field label="Runs">
            <Input
              className="mt-0 font-normal"
              type="number"
              min={1}
              value={form.runs}
              onChange={(e) => set("runs", Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </Field>
        </div>
        <p className="-mt-2 mb-0 text-[length:var(--text-meta)] text-ink-muted">
          Runs is how many times the pipeline runs. Each run after the first reviews and refines the
          one before it.
        </p>
        <Field label="Command template">
          <NativeSelect
            className="w-full"
            value={form.command ?? ""}
            onChange={(e) => set("command", e.target.value || null)}
          >
            <option value="">None</option>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Prompt">
          <Textarea
            className="mt-0 min-h-48 font-sans font-normal"
            value={form.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            placeholder="Describe what you want done."
          />
        </Field>
        <TaskAttachments
          pid={pid}
          taskId={task?.frontmatter.id ?? null}
          attachments={task?.frontmatter.attachments ?? []}
          locked={locked}
          ensureId={ensureId}
          onChanged={(id) => (isNew ? onCreated(id) : void reload())}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        {isNew ? (
          <>
            <Button
              type="button"
              disabled={isBusy || !form.title.trim()}
              onClick={() => void create("pending")}
            >
              Queue
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isBusy || !form.title.trim()}
              onClick={() => void create("draft")}
            >
              Save as draft
            </Button>
          </>
        ) : (
          <>
            <Button type="submit" disabled={isBusy || locked || !dirty || !form.title.trim()}>
              Save changes
            </Button>
            {savedAt && !dirty && (
              <span className="text-[length:var(--text-row)] text-ink-muted">
                Saved {relativeTime(savedAt)}
              </span>
            )}
          </>
        )}
      </div>
    </form>
  );
}
