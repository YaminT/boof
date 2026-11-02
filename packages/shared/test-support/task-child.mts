// Child process for the cross-process task lock test: works on one task of a shared project dir.
// argv: <projectDir> <server|editor> <startAtMs> <task id> <ops>. Prints one JSON line.
//   server: the runner's side, moves the task pending -> running -> pending, counting in completedRuns.
//   editor: the CLI/MCP side, modify()s the task, counting in priority.
import { TaskStore } from "../src/store.ts";

const [dir, mode, startAt, id, ops] = process.argv.slice(2);
const store = new TaskStore(dir);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
let done = 0;
try {
  for (let i = 0; i < Number(ops); i++) {
    if (mode === "server") {
      await store.transition(id, "running");
      await store.transition(id, "pending", (t) => {
        t.frontmatter.completedRuns += 1;
      });
    } else {
      await store.modify(id, (t) => {
        t.frontmatter.priority += 1;
      });
    }
    done++;
  }
  console.log(JSON.stringify({ ok: true, ops: done }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, ops: done, message: (err as Error).message }));
}
