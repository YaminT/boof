import { useCallback, useEffect, useState } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { api } from "../api.js";
import { Button } from "@/ui/button";
import { act } from "../lib/act.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/** Archived projects, with Unarchive and a confirmed Delete. */
export function ArchivedProjects({ reloadProjects }: { reloadProjects: () => Promise<void> }) {
  const [list, setList] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await api.listProjects(true);
      setList(all.filter((p) => p.archived));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const unarchive = async (p: Project) => {
    const ok = await act(() => api.unarchiveProject(p.id), {
      success: "Project unarchived",
      failure: "Could not unarchive the project",
    });
    if (ok) {
      await reloadProjects();
      await load();
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-[length:var(--text-section)] font-semibold">Archived projects</h2>
      {failed ? (
        <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
          Could not load archived projects.
          <Button variant="outline" size="xs" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : list === null ? null : list.length === 0 ? (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">No archived projects.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((p) => (
            <li
              key={p.id}
              className="flex min-h-10 items-center gap-3 border-b border-line text-[length:var(--text-row)] last:border-b-0"
            >
              <span className="font-medium">{p.name}</span>
              <span className="font-mono text-[length:var(--text-meta)] text-ink-muted">
                {p.id}
              </span>
              <span
                className="hidden min-w-0 flex-1 truncate font-mono text-[length:var(--text-meta)] text-ink-muted min-[720px]:block"
                title={p.workingDirectory}
              >
                <bdi>{p.workingDirectory}</bdi>
              </span>
              <span className="ml-auto flex gap-2">
                <Button size="sm" onClick={() => void unarchive(p)}>
                  Unarchive
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDeleting(p)}>
                  Delete…
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete project"
        body={
          deleting
            ? `Delete “${deleting.name}” for good? Boof removes its tasks, plans and history. The repository at ${deleting.workingDirectory} is not touched.`
            : ""
        }
        confirmLabel="Delete project"
        cancelLabel="Keep project"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const ok = await act(() => api.deleteProject(deleting.id, true), {
            failure: "Could not delete the project",
          });
          if (ok) {
            await reloadProjects();
            await load();
          }
        }}
      />
    </section>
  );
}
