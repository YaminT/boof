// Child process for auth-store tests: hammers one AuthStore on a shared data root.
// argv: <root> <touch|revoke> <startAtMs> <comma-separated client ids>. Prints one JSON line.
import { AuthStore } from "../src/auth-store.ts";

const [root, mode, startAt, ids] = process.argv.slice(2);
const store = new AuthStore(root);
const list = ids.split(",");
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const stop = Date.now() + 1500;
let ops = 0;
try {
  if (mode === "touch") {
    // Keep touching every client, the way the server does on each authenticated request.
    while (Date.now() < stop) {
      for (const id of list) {
        await store.touch(id);
        ops++;
      }
    }
  } else {
    for (const id of list) {
      await store.revoke(id);
      ops++;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  console.log(JSON.stringify({ ok: true, ops }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, message: (err as Error).message }));
}
