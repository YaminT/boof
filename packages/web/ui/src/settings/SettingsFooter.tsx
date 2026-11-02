import { Button } from "@/ui/button";

/** The sticky bar of a form page: what state the page is in, and "Save changes". */
export function SettingsFooter({
  dirty,
  elsewhere,
  busy,
  problems,
  savedAt,
  onSave,
  onReload,
}: {
  dirty: boolean;
  elsewhere: boolean;
  busy: boolean;
  problems: string[];
  savedAt: number | null;
  onSave: () => void;
  onReload: () => void;
}) {
  return (
    <div className="sticky bottom-14 z-10 -mx-1 mt-6 flex flex-wrap items-center gap-3 border-t border-line bg-surface px-1 py-3 min-[720px]:bottom-0">
      <div className="min-w-0 flex-1 text-[length:var(--text-row)]">
        {elsewhere ? (
          <span role="status" className="flex flex-wrap items-center gap-2 text-attention">
            These settings changed elsewhere. Reload to see them, or save to keep yours.
            <Button type="button" variant="outline" size="xs" onClick={onReload}>
              Reload
            </Button>
          </span>
        ) : problems.length > 0 && dirty ? (
          <span role="alert" className="text-failed">
            {problems[0]}
          </span>
        ) : dirty ? (
          <span className="text-ink-muted">Unsaved changes</span>
        ) : savedAt ? (
          <span className="text-ink-muted">Saved</span>
        ) : null}
      </div>
      <Button onClick={onSave} disabled={!dirty || busy || problems.length > 0}>
        Save changes
      </Button>
    </div>
  );
}
