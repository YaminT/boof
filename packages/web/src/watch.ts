import chokidar, { type FSWatcher } from "chokidar";
import { dataPaths } from "@boof-runner/shared";

type Listener = (event: string) => void;

/**
 * Watches the data root and broadcasts debounced "changed" pings to subscribers
 * (web-server spec). SSE is a hint only: clients re-fetch a fresh list on each
 * ping and on reconnect, so a missed event never desyncs them.
 */
export class DataWatcher {
  private watcher: FSWatcher | null = null;
  private readonly listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly debounceMs = 150,
  ) {}

  start(): void {
    if (this.watcher) return;
    const paths = dataPaths(this.root);
    this.watcher = chokidar.watch([paths.tasks, paths.commands, paths.settings], {
      ignoreInitial: true,
      depth: 4,
    });
    const ping = () => this.schedule();
    this.watcher
      .on("add", ping)
      .on("change", ping)
      .on("unlink", ping)
      .on("addDir", ping)
      .on("unlinkDir", ping);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.broadcast("changed"), this.debounceMs);
  }

  broadcast(event: string): void {
    for (const l of this.listeners) l(event);
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
