import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import type { TaskDiff } from "../api-types.js";
import { gitCommands, parseFilePatch, splitPatch } from "../diff-parse.js";

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

function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="btn-secondary"
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
    return <p className="muted diff-empty">No textual changes (mode change or empty file).</p>;
  }
  return (
    <div className="diff-box" tabIndex={0} role="region" aria-label={`Diff of ${path}`}>
      <table className="diff-table">
        <tbody>
          {shown.map((r, i) =>
            r.kind === "hunk" || r.kind === "note" ? (
              <tr key={i} className={`diff-row diff-${r.kind}`}>
                <td className="diff-no" />
                <td className="diff-no" />
                <td className="diff-sign" />
                <td className="diff-code">{r.text}</td>
              </tr>
            ) : (
              <tr key={i} className={`diff-row diff-${r.kind}`}>
                <td className="diff-no">{r.oldNo ?? ""}</td>
                <td className="diff-no">{r.newNo ?? ""}</td>
                <td
                  className="diff-sign"
                  aria-label={r.kind === "add" ? "added" : r.kind === "del" ? "removed" : undefined}
                >
                  {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                </td>
                <td className="diff-code">{r.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <p className="muted diff-empty">
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

  if (loading) return <p className="muted">Loading changes…</p>;
  if (error) {
    return (
      <div className="changes">
        <p className={error.code === "branch_not_found" ? "muted" : "error"}>
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
    <div className="changes">
      <div className="changes-head">
        <div className="changes-summary">
          <strong>
            {diff.stats.files} file{diff.stats.files === 1 ? "" : "s"}
          </strong>{" "}
          <span className="diff-add-count">+{diff.stats.additions}</span>{" "}
          <span className="diff-del-count">−{diff.stats.deletions}</span>
          <span className="muted">
            , {diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"}, base{" "}
            <code title={diff.base.sha}>
              {diff.base.ref} @ {diff.base.sha.slice(0, 7)}
            </code>{" "}
            → <code title={diff.head.sha}>{branch}</code>
          </span>
        </div>
        <div className="changes-actions">
          <CopyButton label="Copy branch name" text={branch} />
          <CopyButton label="Copy git commands" text={cmds} />
        </div>
      </div>

      {diff.includesUncommitted && (
        <p className="changes-note">
          Includes uncommitted changes from the task&apos;s worktree; they are not on the branch
          yet.
        </p>
      )}
      {diff.leftovers && (
        <p className="changes-note">
          Uncommitted work of an earlier run is saved on <code>{diff.leftovers.ref}</code>.
        </p>
      )}
      {diff.truncated && diff.patch === undefined && (
        <p className="changes-note">Large change: patches load per file when you select it.</p>
      )}

      <h4 className="changes-h">Commits</h4>
      {diff.commits.length === 0 ? (
        <p className="muted">
          No commits on the branch{diff.includesUncommitted ? " (only uncommitted changes)" : ""}.
        </p>
      ) : (
        <ul className="commit-list">
          {diff.commits.map((c) => (
            <li key={c.sha}>
              <code className="commit-sha">{c.sha.slice(0, 7)}</code>
              <span className="commit-subject">{c.subject}</span>
              <span className="muted commit-meta">
                {c.author}, {new Date(c.date).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 className="changes-h">Files</h4>
      {diff.files.length === 0 ? (
        <p className="muted">No changed files.</p>
      ) : (
        <div className="changes-body">
          <ul className="file-list" aria-label="Changed files">
            {diff.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={`file-item${f.path === selected ? " active" : ""}`}
                  aria-current={f.path === selected ? "true" : undefined}
                  onClick={() => setSelected(f.path)}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                >
                  <span className={`file-status file-${f.status}`} title={f.status}>
                    {STATUS_MARK[f.status]}
                  </span>
                  <span className="file-path">{f.path}</span>
                  {f.status === "binary" ? (
                    <span className="muted file-counts">binary</span>
                  ) : (
                    <span className="file-counts">
                      <span className="diff-add-count">+{f.additions}</span>{" "}
                      <span className="diff-del-count">−{f.deletions}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="changes-file">
            {file && (
              <div className="changes-file-head">
                <code>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</code>
              </div>
            )}
            {file?.status === "binary" ? (
              <p className="muted diff-empty">Binary file: not shown.</p>
            ) : fileError ? (
              <p className="error">{fileError}</p>
            ) : cur ? (
              <>
                <DiffView path={file?.path ?? ""} patch={cur.patch} />
                {cur.truncated && (
                  <p className="changes-note">
                    This file&apos;s diff is cut at the size limit. Read the rest with the git
                    commands.
                  </p>
                )}
              </>
            ) : loadingFile ? (
              <p className="muted diff-empty">Loading diff…</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
