import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import type { TaskDiff } from "../api-types.js";
import { gitCommands, parseFilePatch, splitPatch } from "../diff-parse.js";
import { cn } from "@/lib/utils";

const STATUS_MARK: Record<TaskDiff["files"][number]["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  binary: "B",
};

/** Rows rendered per file before the rest is cut (the whole file is a click away in a terminal). */
const MAX_ROWS = 3000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const NO =
  "w-px min-w-11 bg-page px-2 text-right align-top tabular-nums text-ink-muted select-none";
const SIGN = "w-px px-1 text-center align-top select-none";
const CODE = "px-2 align-top whitespace-pre";
const ADD_COUNT = "font-semibold tabular-nums text-done";
const DEL_COUNT = "font-semibold tabular-nums text-failed";
const NOTE = "my-2 rounded-lg bg-accent-brand/10 px-3 py-2 text-[length:var(--text-row)]";
const HEAD = "mt-[18px] mb-2 text-[length:var(--text-body)] text-ink-muted";

function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="rounded-md border border-line bg-transparent px-2.5 py-1 text-[length:var(--text-meta)] font-semibold text-ink outline-none hover:border-accent-brand hover:text-accent-brand focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={async () => {
        setState((await copyText(text)) ? "ok" : "fail");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1800);
      }}
    >
      {state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : label}
    </button>
  );
}

function DiffView({ path, patch }: { path: string; patch: string }) {
  const rows = useMemo(() => parseFilePatch(patch), [patch]);
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  if (rows.length === 0) {
    return (
      <p className="m-0 p-3 text-ink-muted">No textual changes (mode change or empty file).</p>
    );
  }
  return (
    <div
      className="max-h-[640px] overflow-auto rounded-b-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      tabIndex={0}
      role="region"
      aria-label={`Diff of ${path}`}
    >
      <table className="min-w-full border-collapse font-mono text-[12px] leading-normal">
        <tbody>
          {shown.map((r, i) =>
            r.kind === "hunk" || r.kind === "note" ? (
              <tr
                key={i}
                className={
                  r.kind === "hunk"
                    ? "bg-accent-brand/10 text-accent-brand"
                    : "text-ink-muted italic"
                }
              >
                <td className={NO} />
                <td className={NO} />
                <td className={SIGN} />
                <td className={CODE}>{r.text}</td>
              </tr>
            ) : (
              <tr
                key={i}
                className={
                  r.kind === "add" ? "bg-done/15" : r.kind === "del" ? "bg-failed/15" : undefined
                }
              >
                <td className={NO}>{r.oldNo ?? ""}</td>
                <td className={NO}>{r.newNo ?? ""}</td>
                <td
                  className={cn(
                    SIGN,
                    r.kind === "add" && "font-bold text-done",
                    r.kind === "del" && "font-bold text-failed",
                  )}
                  aria-label={r.kind === "add" ? "added" : r.kind === "del" ? "removed" : undefined}
                >
                  {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                </td>
                <td className={CODE}>{r.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <p className="m-0 p-3 text-ink-muted">
          Showing the first {MAX_ROWS} of {rows.length} lines. Use the git commands to read the
          rest.
        </p>
      )}
    </div>
  );
}

export function ChangesPanel({
  projectId,
  taskId,
  status,
  tick,
}: {
  projectId: string;
  taskId: string;
  status: string;
  /** Bumped by the parent on live events so a running task's changes refresh. */
  tick: number;
}) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [repo, setRepo] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  // Patches by file: split out of the whole-diff patch, or fetched per file.
  const [patches, setPatches] = useState<Record<string, { patch: string; truncated: boolean }>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    void api
      .getProject(projectId)
      .then((p) => setRepo(p.workingDirectory))
      .catch(() => {});
  }, [projectId]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.getTaskDiff(projectId, taskId);
      if (mine !== seq.current) return;
      setDiff(d);
      setError(null);
      // The head moved or the worktree changed: drop cached patches, keep what came with this load.
      const next: Record<string, { patch: string; truncated: boolean }> = {};
      if (d.patch !== undefined) {
        for (const [p, text] of splitPatch(d.patch)) next[p] = { patch: text, truncated: false };
      }
      setPatches(next);
      setSelected((cur) =>
        cur && d.files.some((f) => f.path === cur) ? cur : (d.files[0]?.path ?? null),
      );
    } catch (e) {
      if (mine !== seq.current) return;
      setDiff(null);
      setError({
        message: e instanceof Error ? e.message : String(e),
        ...(e instanceof ApiError && e.code ? { code: e.code } : {}),
      });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [projectId, taskId]);

  // Load on open and on every status change; a running task refreshes on live events (debounced).
  useEffect(() => {
    void load();
  }, [load, status]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(), 800);
    return () => clearTimeout(t);
  }, [tick, load]);

  // Fetch the selected file's patch when it did not come with the file list.
  useEffect(() => {
    if (!diff || !selected || patches[selected]) return;
    const file = diff.files.find((f) => f.path === selected);
    if (!file) return;
    if (file.status === "binary") return;
    let cancelled = false;
    setLoadingFile(selected);
    setFileError(null);
    api
      .getTaskDiff(projectId, taskId, { path: selected })
      .then((d) => {
        if (!cancelled) {
          setPatches((p) => ({
            ...p,
            [selected]: { patch: d.patch ?? "", truncated: d.truncated },
          }));
        }
      })
      .catch((e) => {
        if (!cancelled) setFileError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diff, selected, patches, projectId, taskId]);

  if (loading) return <p className="text-ink-muted">Loading changes…</p>;
  if (error) {
    return (
      <div className="min-w-0">
        <p className={error.code === "branch_not_found" ? "text-ink-muted" : "text-failed"}>
          {error.code === "branch_not_found"
            ? `There is no branch to review: ${error.message}.`
            : error.message}
        </p>
      </div>
    );
  }
  if (!diff) return null;

  const branch = diff.head.ref;
  const cmds = gitCommands(repo, diff.base.sha, branch);
  const file = diff.files.find((f) => f.path === selected);
  const cur = selected ? patches[selected] : undefined;

  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <div className="text-[length:var(--text-body)]">
          <strong>
            {diff.stats.files} file{diff.stats.files === 1 ? "" : "s"}
          </strong>{" "}
          <span className={ADD_COUNT}>+{diff.stats.additions}</span>{" "}
          <span className={DEL_COUNT}>−{diff.stats.deletions}</span>
          <span className="text-ink-muted">
            , {diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"}, base{" "}
            <code title={diff.base.sha}>
              {diff.base.ref} @ {diff.base.sha.slice(0, 7)}
            </code>{" "}
            → <code title={diff.head.sha}>{branch}</code>
          </span>
        </div>
        <div className="flex gap-2">
          <CopyButton label="Copy branch name" text={branch} />
          <CopyButton label="Copy git commands" text={cmds} />
        </div>
      </div>

      {diff.includesUncommitted && (
        <p className={NOTE}>
          Includes uncommitted changes from the task&apos;s worktree; they are not on the branch
          yet.
        </p>
      )}
      {diff.leftovers && (
        <p className={NOTE}>
          Uncommitted work of an earlier run is saved on <code>{diff.leftovers.ref}</code>.
        </p>
      )}
      {diff.truncated && diff.patch === undefined && (
        <p className={NOTE}>Large change: patches load per file when you select it.</p>
      )}

      <h4 className={HEAD}>Commits</h4>
      {diff.commits.length === 0 ? (
        <p className="text-ink-muted">
          No commits on the branch{diff.includesUncommitted ? " (only uncommitted changes)" : ""}.
        </p>
      ) : (
        <ul className="m-0 max-h-[220px] list-none overflow-auto rounded-lg border border-line p-0">
          {diff.commits.map((c) => (
            <li
              key={c.sha}
              className="flex items-baseline gap-2.5 border-b border-line px-3 py-1.5 text-[length:var(--text-row)] last:border-b-0"
            >
              <code className="font-mono text-[12px] text-accent-brand">{c.sha.slice(0, 7)}</code>
              <span className="min-w-0 flex-1 truncate">{c.subject}</span>
              <span className="whitespace-nowrap text-[length:var(--text-meta)] text-ink-muted">
                {c.author}, {new Date(c.date).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 className={HEAD}>Files</h4>
      {diff.files.length === 0 ? (
        <p className="text-ink-muted">No changed files.</p>
      ) : (
        <div className="grid items-start gap-3.5 min-[800px]:grid-cols-[minmax(200px,320px)_minmax(0,1fr)]">
          <ul
            className="m-0 max-h-[560px] list-none overflow-auto rounded-lg border border-line p-0"
            aria-label="Changed files"
          >
            {diff.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 border-0 border-b border-line bg-transparent px-2.5 py-1.5 text-left text-[12.5px] text-ink outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    f.path === selected && "bg-accent-brand/10",
                  )}
                  aria-current={f.path === selected ? "true" : undefined}
                  onClick={() => setSelected(f.path)}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                >
                  <span
                    className={cn(
                      "size-[18px] flex-none rounded bg-page text-center text-[11px] leading-[18px] font-bold text-ink-muted",
                      f.status === "added" && "text-done",
                      f.status === "deleted" && "text-failed",
                      (f.status === "renamed" || f.status === "modified") && "text-attention",
                    )}
                    title={f.status}
                  >
                    {STATUS_MARK[f.status]}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                  {f.status === "binary" ? (
                    <span className="text-[length:var(--text-meta)] whitespace-nowrap text-ink-muted">
                      binary
                    </span>
                  ) : (
                    <span className="text-[length:var(--text-meta)] whitespace-nowrap">
                      <span className={ADD_COUNT}>+{f.additions}</span>{" "}
                      <span className={DEL_COUNT}>−{f.deletions}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            {file && (
              <div className="rounded-t-lg border border-b-0 border-line bg-page px-3 py-1.5 [overflow-wrap:anywhere]">
                <code>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</code>
              </div>
            )}
            {file?.status === "binary" ? (
              <p className="m-0 p-3 text-ink-muted">Binary file: not shown.</p>
            ) : fileError ? (
              <p className="text-failed">{fileError}</p>
            ) : cur ? (
              <>
                <DiffView path={file?.path ?? ""} patch={cur.patch} />
                {cur.truncated && (
                  <p className={NOTE}>
                    This file&apos;s diff is cut at the size limit. Read the rest with the git
                    commands.
                  </p>
                )}
              </>
            ) : loadingFile ? (
              <p className="m-0 p-3 text-ink-muted">Loading diff…</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
