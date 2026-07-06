import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useLive } from "../useLive.js";
import type { Attachment, CommandTemplate, Task } from "../types.js";
import { FileIcon, PaperclipIcon, XIcon } from "./Icons.js";

const NEW = "__new__";

const ATTACH_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf";

type OutputTab = "planner" | "developer" | "reviewer" | "log";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChip({
  taskId,
  attachment,
  onRemove,
}: {
  taskId: string;
  attachment: Attachment;
  onRemove: () => void;
}) {
  const isImage = attachment.type.startsWith("image/");
  return (
    <div className="attachment-chip" title={`${attachment.name} · ${formatSize(attachment.size)}`}>
      {isImage ? (
        <img
          className="attachment-thumb"
          src={api.attachmentUrl(taskId, attachment.name)}
          alt={attachment.name}
        />
      ) : (
        <span className="attachment-thumb attachment-thumb-file">
          <FileIcon />
        </span>
      )}
      <span className="attachment-name">{attachment.name}</span>
      <button
        type="button"
        className="attachment-remove"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        title="Remove"
      >
        <XIcon />
      </button>
    </div>
  );
}

export function Editor({
  taskId,
  onClose,
  onChange,
}: {
  taskId: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const isNew = taskId === NEW;
  const [task, setTask] = useState<Task | null>(null);
  // Once a brand-new task gets an attachment (or is saved), it has a real id we
  // keep editing under, so we don't create duplicate drafts.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [priority, setPriority] = useState(50);
  const [runs, setRuns] = useState(1);
  const [labels, setLabels] = useState("");
  const [command, setCommand] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [outTab, setOutTab] = useState<OutputTab>("log");
  // Live streaming agent output while the task runs (chunk-by-chunk from the
  // server's log.txt tail). Null when the task isn't running.
  const [liveLog, setLiveLog] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const effectiveId = isNew ? createdId : taskId;
  const attachments = task?.frontmatter.attachments ?? [];

  useEffect(() => {
    void api.listCommands().then(setCommands);
    if (!isNew) {
      void api.getTask(taskId).then((t) => {
        setTask(t);
        setTitle(t.frontmatter.title);
        setPrompt(t.body.prompt);
        setPriority(t.frontmatter.priority);
        setRuns(t.frontmatter.runs);
        setLabels(t.frontmatter.labels.join(", "));
        setCommand(t.frontmatter.command);
      });
    }
  }, [taskId, isNew]);

  // Live-refresh only the task object (reports/log/status) while the editor is
  // open, so a running task's output streams in without clobbering form edits.
  const refreshTask = useCallback(() => {
    const id = effectiveId;
    if (!id) return;
    void api.getTask(id).then((t) => {
      setTask(t);
      // While running, pull the streaming log tail; otherwise the durable
      // body.log (shown directly) is authoritative, so drop the live buffer.
      if (t.frontmatter.status === "running") {
        void api
          .liveLog(id)
          .then((r) => setLiveLog(r.log))
          .catch(() => {});
      } else {
        setLiveLog(null);
      }
    });
  }, [effectiveId]);
  useLive(refreshTask);

  // Keep the log view pinned to the newest output while streaming.
  useEffect(() => {
    if (outTab === "log" && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [liveLog, outTab]);

  const parsedLabels = () =>
    labels
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

  const save = async (status?: "draft" | "pending") => {
    setError(null);
    try {
      const payload = { title, prompt, priority, runs, labels: parsedLabels(), command };
      if (effectiveId) {
        await api.updateTask(effectiveId, { ...payload, ...(status ? { status } : {}) });
      } else {
        await api.createTask({ ...payload, status: status ?? "draft" });
      }
      onChange();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Ensure a real task id exists before attaching files to a brand-new task by
  // saving a draft with the current form values.
  const ensureTaskId = async (): Promise<string> => {
    if (effectiveId) return effectiveId;
    const created = await api.createTask({
      title: title.trim() || "Untitled task",
      prompt,
      priority,
      runs,
      labels: parsedLabels(),
      command,
      status: "draft",
    });
    setCreatedId(created.frontmatter.id);
    setTask(created);
    if (!title.trim()) setTitle(created.frontmatter.title);
    return created.frontmatter.id;
  };

  const onFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachError(null);
    setUploading(true);
    try {
      const id = await ensureTaskId();
      let latest: Task | null = null;
      for (const f of list) {
        latest = await api.uploadAttachment(id, f);
      }
      if (latest) setTask(latest);
      onChange();
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (name: string) => {
    if (!effectiveId) return;
    try {
      const updated = await api.deleteAttachment(effectiveId, name);
      setTask(updated);
      onChange();
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) void onFiles(e.dataTransfer.files);
  };

  const canEnqueue = isNew
    ? task?.frontmatter.status === "draft" || !effectiveId
    : task?.frontmatter.status === "draft";

  return (
    <div className="editor">
      <div className="editor-head">
        <button onClick={onClose}>← Back</button>
        <h2>{isNew && !effectiveId ? "New task" : `Edit: ${task?.frontmatter.id ?? taskId}`}</h2>
      </div>
      {error && <p className="error">{error}</p>}

      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
      </label>

      <label>
        Priority
        <input
          type="number"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
      </label>

      <label>
        Runs
        <input
          type="number"
          min={1}
          value={runs}
          onChange={(e) => setRuns(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
        <small className="muted">
          How many times to run the pipeline. Runs after the first review and refine the prior run's
          work, treating it critically as another AI's solution.
        </small>
      </label>

      <label>
        Labels (comma-separated)
        <input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          placeholder="backend, auth"
        />
      </label>

      <label>
        Command template
        <select value={command ?? ""} onChange={(e) => setCommand(e.target.value || null)}>
          <option value="">(none)</option>
          {commands.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="prompt-field">
        Prompt (markdown)
        <div
          className={`prompt-drop${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={16}
            placeholder="Describe what you want done… (drop images or PDFs here to attach)"
          />
          {dragging && <div className="prompt-drop-hint">Drop to attach</div>}
        </div>
      </label>

      <div className="attachments">
        <div className="attachments-bar">
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            <PaperclipIcon /> {uploading ? "Uploading…" : "Attach image or PDF"}
          </button>
          <small className="muted">PNG, JPG, GIF, WebP, or PDF — up to 25 MB each.</small>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files) void onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {attachError && <p className="error">{attachError}</p>}
        {attachments.length > 0 && effectiveId && (
          <div className="attachment-list">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.name}
                taskId={effectiveId}
                attachment={a}
                onRemove={() => removeAttachment(a.name)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="editor-actions">
        <button onClick={() => save()} disabled={!title}>
          Save {isNew && !effectiveId ? "draft" : ""}
        </button>
        {canEnqueue && (
          <button className="primary" onClick={() => save("pending")} disabled={!title}>
            Save & enqueue
          </button>
        )}
      </div>

      {!isNew && task && (
        <section className="output">
          <div className="output-head">
            <h3>Agent output</h3>
            <span className={`status-pill status-${task.frontmatter.status}`}>
              {task.frontmatter.status}
            </span>
            {task.frontmatter.status === "failed" && (
              <button
                className="retry-btn"
                title="Clear the failed status and re-queue this task"
                onClick={async () => {
                  await api.retry(task.frontmatter.id);
                  onChange();
                  refreshTask();
                }}
              >
                ↻ Retry
              </button>
            )}
          </div>
          <div className="output-tabs">
            {(["planner", "developer", "reviewer", "log"] as const).map((k) => {
              const hasContent =
                k === "log" ? !!(liveLog ?? task.body.log) : !!task.body.reports[k];
              return (
                <button
                  key={k}
                  className={outTab === k ? "active" : ""}
                  onClick={() => setOutTab(k)}
                  title={hasContent ? undefined : "No content yet"}
                >
                  {k === "log" ? "Log" : k[0].toUpperCase() + k.slice(1)}
                  {k === "log" && liveLog !== null ? (
                    <span className="live-dot" title="Streaming live" />
                  ) : hasContent ? (
                    <span className="dot" />
                  ) : null}
                </button>
              );
            })}
          </div>
          <pre className="output-body" ref={logRef}>
            {outTab === "log"
              ? (liveLog ?? task.body.log) || "No agent output captured yet."
              : task.body.reports[outTab] || `No ${outTab} report yet.`}
          </pre>
        </section>
      )}
    </div>
  );
}
