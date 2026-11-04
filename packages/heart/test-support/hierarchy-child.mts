// Child process for the hierarchy / epics lock test: one side of a race on a shared project dir.
// argv: <projectDir> <mode> <startAtMs> <arg> <count>. Prints one JSON line.
//   epics:   create <count> epics titled "<arg>-<n>" (every epics.json write is a read-modify-write)
//   tasks:   create <count> tasks "<arg>-<n>" in epic <arg>, ignoring epic_not_found
//   remove:  remove epic <arg> with detach, after <count> ms
import { EpicStore } from "../src/epic-store.ts";
import { createTaskInHierarchy, HierarchyError, removeEpic } from "../src/hierarchy.ts";
import { newTask } from "../src/task-file.ts";

const [dir, mode, startAt, arg, count] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
let done = 0;
try {
  if (mode === "epics") {
    const store = new EpicStore(dir);
    for (let i = 0; i < Number(count); i++) {
      await store.create({ title: `${arg}-${i}` });
      done++;
    }
  } else if (mode === "tasks") {
    for (let i = 0; i < Number(count); i++) {
      const id = `${arg}-${i}`;
      try {
        await createTaskInHierarchy(
          dir,
          newTask(
            {
              id,
              title: id,
              status: "pending",
              priority: 0,
              skip: false,
              labels: [],
              command: null,
              attachments: [],
              questions: "none",
              runs: 1,
              completedRuns: 0,
              epicId: arg,
              created: "2026-06-04T10:00:00.000Z",
              updated: "2026-06-04T10:00:00.000Z",
            },
            id,
          ),
        );
        done++;
      } catch (err) {
        if (!(err instanceof HierarchyError && err.code === "epic_not_found")) throw err;
      }
    }
  } else {
    await new Promise((r) => setTimeout(r, Number(count)));
    await removeEpic(dir, arg, { detach: true });
    done++;
  }
  console.log(JSON.stringify({ ok: true, ops: done }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, ops: done, message: (err as Error).message }));
}
