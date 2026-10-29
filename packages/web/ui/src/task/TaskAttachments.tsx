import { useEffect, useRef, useState } from "react";
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import type { Attachment } from "@boof-runner/shared/schema";
import { Button } from "@/ui/button";
import { api } from "../api.js";

const ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chip({
  pid,
  taskId,
  attachment,
  disabled,
  onRemove,
}: {
  pid: string;
  taskId: string;
  attachment: Attachment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const isImage = attachment.type.startsWith("image/");
  // <img src> cannot send the Authorization header, so load the bytes with fetch.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let url: string | null = null;
    let cancelled = false;
    void api
      .attachmentBlobUrl(pid, taskId, attachment.name)
      .then((u) => {
        if (cancelled) URL.revokeObjectURL(u);
        else {
          url = u;
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [isImage, pid, taskId, attachment.name]);
  return (
    <li
      className="flex max-w-full items-center gap-2 rounded-md border border-line bg-surface py-1 pr-1 pl-1 text-[length:var(--text-row)]"
      title={`${attachment.name}, ${formatSize(attachment.size)}`}
    >
      {isImage ? (
        <img className="size-8 rounded object-cover" src={src ?? undefined} alt={attachment.name} />
      ) : (
        <span className="flex size-8 items-center justify-center rounded bg-page text-ink-muted">
          <FileIcon className="size-4" />
        </span>
      )}
      <span className="min-w-0 truncate">{attachment.name}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${attachment.name}`}
      >
        <XIcon />
      </Button>
    </li>
  );
}

/**
 * Attach images and PDFs. `ensureId` gives the task to attach to (a new task is saved as a draft
 * first); `onChanged` runs with that id once files were added or removed.
 */
export function TaskAttachments({
  pid,
  taskId,
  attachments,
  locked,
  ensureId,
  onChanged,
}: {
  pid: string;
  taskId: string | null;
  attachments: Attachment[];
  locked: boolean;
  ensureId: () => Promise<string>;
  onChanged: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const id = await ensureId();
      for (const f of list) await api.uploadAttachment(pid, id, f);
      onChanged(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (name: string) => {
    if (!taskId) return;
    try {
      await api.deleteAttachment(pid, taskId, name);
      onChanged(taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => input.current?.click()}
          disabled={locked || uploading}
        >
          <PaperclipIcon />
          {uploading ? "Uploading…" : "Attach image or PDF"}
        </Button>
        <span className="text-[length:var(--text-meta)] text-ink-muted">
          PNG, JPG, GIF, WebP or PDF, up to 25 MB each.
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="m-0 text-[length:var(--text-row)] text-failed">{error}</p>}
      {attachments.length > 0 && taskId && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {attachments.map((a) => (
            <Chip
              key={a.name}
              pid={pid}
              taskId={taskId}
              attachment={a}
              disabled={locked}
              onRemove={() => void remove(a.name)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
