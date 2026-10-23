import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import { dataRootPaths } from "@boof-runner/shared";

/** Payload of a `changed` ping: the project whose files changed, or none for global changes. */
export interface ChangeData {
  project?: string;
}

type Listener = (event: string, data: ChangeData) => void;

/**
 * Watches the data root and broadcasts debounced "changed" pings to subscribers
 * (web-server spec). SSE is a hint only: clients re-fetch a fresh list on each
 * ping and on reconnect, so a missed event never desyncs them.
 */
export class DataWatcher {
  private watcher: FSWatcher | null = null;
  private readonly listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  /** Project ids changed since the last broadcast, and whether anything outside projects/ did. */
  private pendingProjects = new Set<string>();
  private pendingGlobal = false;

  constructor(
    private readonly root: string,
    private readonly debounceMs = 150,
  ) {}

  start(): void {
    if (this.watcher) return;
    const paths = dataRootPaths(this.root);
    this.watcher = chokidar.watch([paths.projects, paths.commands, paths.settings], {
      ignoreInitial: true,
      depth: 6,
    });
    const ping = (path: string) => this.schedule(path);
    this.watcher
      .on("add", ping)
      .on("change", ping)
      .on("unlink", ping)
      .on("addDir", ping)
      .on("unlinkDir", ping);
  }

  /** The project id when `path` is under projects/<id>/, else undefined. */
  private projectOf(path: string): string | undefined {
    const rel = relative(dataRootPaths(this.root).projects, path);
    if (rel === "" || rel.startsWith("..")) return undefined;
    return rel.split(sep)[0] || undefined;
  }

  private schedule(path: string): void {
    const project = this.projectOf(path);
    if (project) this.pendingProjects.add(project);
    else this.pendingGlobal = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    const projects = [...this.pendingProjects].sort();
    const global = this.pendingGlobal;
    this.pendingProjects.clear();
    this.pendingGlobal = false;
    for (const project of projects) this.broadcast("changed", { project });
    if (global) this.broadcast("changed", {});
  }

  broadcast(event: string, data: ChangeData = {}): void {
    for (const l of this.listeners) l(event, data);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }
}
