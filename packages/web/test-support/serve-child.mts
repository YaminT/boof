// Child process for the webhook dispatcher test: a real server (startServer) on a shared data
// root, with a fast delivery loop. argv: <dataRoot>. Prints {"port": n} once it listens.
import { MockTool, ToolRegistry } from "../../runner/src/index.ts";
import { startServer } from "../src/server.ts";

const [root] = process.argv.slice(2);
const running = await startServer({
  root,
  port: 0,
  registry: new ToolRegistry([new MockTool()]),
  webhookIntervalMs: 100,
  webhookLockRetryMs: 200,
  warn: () => {},
});
console.log(JSON.stringify({ port: running.port }));
process.on("SIGTERM", () => void running.stop().then(() => process.exit(0)));
setInterval(() => {}, 1 << 30);
