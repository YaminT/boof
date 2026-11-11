import { formatRoute } from "./route.js";

const NOTICE_KEY = "boof.sandbox-notice";

export interface NoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The one-line notice: mode is off, the last check would pass, and it was not dismissed. */
export function sandboxNoticeVisible(input: {
  mode: string;
  offer: boolean;
  dismissed: boolean;
}): boolean {
  return input.mode === "off" && input.offer && !input.dismissed;
}

export function readSandboxNoticeDismissed(box: NoticeStorage): boolean {
  try {
    return box.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissSandboxNotice(box: NoticeStorage): void {
  box.setItem(NOTICE_KEY, "1");
}

/** The sentence under the switch for the three states. */
export function sandboxStateText(status: { mode: string; state: string; reason: string }): string {
  if (status.mode === "off" || status.state === "off") return "Off. Agents are not sandboxed.";
  if (status.state === "ok") {
    return status.reason
      ? `On. The sandbox self-test passed. ${status.reason}`
      : "On. The sandbox self-test passed.";
  }
  return `Unavailable. ${status.reason}`;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Absolute path, loose enough for a Windows drive letter. The server schema is the authority. */
function absolutePath(value: string): boolean {
  if (value.includes("\0") || value.length > 4096) return false;
  if (value.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(value);
}

export type SandboxListResult =
  | { ok: true; readPaths: string[]; writePaths: string[]; denyTcpPorts: number[] }
  | { ok: false; problems: string[] };

/** One path or port per line. Blanks are dropped. A bad line is named, not saved. */
export function sandboxLists(input: {
  read: string;
  write: string;
  ports: string;
}): SandboxListResult {
  const problems: string[] = [];
  const readPaths = lines(input.read);
  const writePaths = lines(input.write);
  const portLines = lines(input.ports);
  for (const path of readPaths) {
    if (!absolutePath(path)) problems.push(`Read-only folders: ${path} must be an absolute path`);
  }
  for (const path of writePaths) {
    if (!absolutePath(path)) problems.push(`Writable folders: ${path} must be an absolute path`);
  }
  const denyTcpPorts: number[] = [];
  for (const line of portLines) {
    const port = Number(line);
    if (!/^\d+$/.test(line) || port < 1 || port > 65535) {
      problems.push(`Blocked TCP ports: ${line} must be a port from 1 to 65535`);
    } else denyTcpPorts.push(port);
  }
  if (readPaths.length > 100) problems.push("Read-only folders: at most 100");
  if (writePaths.length > 100) problems.push("Writable folders: at most 100");
  if (portLines.length > 100) problems.push("Blocked TCP ports: at most 100");
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, readPaths, writePaths, denyTcpPorts };
}

/**
 * Reason from a failed task log, or null. Only the not-started line and the pipeline error line.
 * A later successful run can leave the old line, so the caller also checks the task status.
 */
export function sandboxUnavailableReason(log: string): string | null {
  for (const line of log.split("\n")) {
    const started = /^sandbox_unavailable: (.*)$/.exec(line);
    if (started) return started[1]!;
    const error = /^ERROR: sandbox_unavailable: (.*)$/.exec(line);
    if (error) return error[1]!;
  }
  return null;
}

/** Settings › Agents, sandbox section. The hash is left for the browser; the section scrolls to it. */
export function sandboxSettingsHref(pid: string): string {
  return `${formatRoute({ name: "settings", pid, page: "agents" })}#sandbox`;
}

/** Turn the sandbox on or off. A refusal is the reason, not a success. */
export async function applySandboxMode(
  mode: "off" | "enforce",
  update: (mode: "off" | "enforce") => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await update(mode);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
