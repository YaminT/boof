// Child process for the pinned-post proxy test: one pinnedPost in a process whose environment
// the parent controls (HTTP_PROXY, NODE_USE_ENV_PROXY). argv: <url> <address>. Prints one JSON line.
import { pinnedPost } from "../src/server/pinned-post.ts";

const [url, address] = process.argv.slice(2);
try {
  const res = await pinnedPost(url, [address], {
    headers: {},
    body: "x",
    signal: AbortSignal.timeout(5000),
  });
  console.log(JSON.stringify({ ok: true, status: res.status }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, message: (err as Error).message }));
}
