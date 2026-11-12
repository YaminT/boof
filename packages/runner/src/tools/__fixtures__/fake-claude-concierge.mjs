#!/usr/bin/env node
// A fake `claude` for the assistant tests. It never contacts a network except the loopback MCP
// endpoint named in the --mcp-config file it is given. Behaviour comes from CLAUDE_FAKE_* variables.
import { appendFileSync, readFileSync, statSync } from "node:fs";

const argv = process.argv.slice(2);
const env = process.env;
const log = (entry) => {
  if (env.CLAUDE_FAKE_LOG) appendFileSync(env.CLAUDE_FAKE_LOG, JSON.stringify(entry) + "\n");
};
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === "--version") {
  console.log("2.9.9 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "--help") {
  const omit = new Set((env.CLAUDE_FAKE_HELP_OMIT ?? "").split(",").filter(Boolean));
  const flags = [
    "--print",
    "--verbose",
    "--output-format",
    "--include-partial-messages",
    "--mcp-config",
    "--strict-mcp-config",
    "--allowedTools, --allowed-tools",
    "--disallowedTools, --disallowed-tools",
    "--setting-sources",
    "--system-prompt",
    "--tools",
    "--resume",
    "--model",
    "--max-budget-usd",
    "--max-turns",
  ].filter((f) => !f.split(", ").some((name) => omit.has(name)));
  console.log(
    "Usage: claude [options]\n\nOptions:\n" + flags.map((f) => `  ${f}  text`).join("\n"),
  );
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const configPath = value("--mcp-config");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const server = config.mcpServers.boof;
const token = server.headers.Authorization.replace(/^Bearer /, "");
log({
  argv,
  prompt,
  configPath,
  configMode: statSync(configPath).mode & 0o777,
  url: server.url,
  token,
  cwd: process.cwd(),
  envKeys: Object.keys(env).filter((k) => !k.startsWith("CLAUDE_FAKE_")),
  baseUrl: env.ANTHROPIC_BASE_URL ?? null,
  authToken: env.ANTHROPIC_AUTH_TOKEN ?? null,
});

const out = (obj) => process.stdout.write(JSON.stringify({ session_id: "sess-1", ...obj }) + "\n");
const mode = env.CLAUDE_FAKE_MODE ?? "plain";
const text = (t) =>
  out({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
  });
const result = (extra = {}) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    total_cost_usd: 0.02,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  });

out({ type: "system", subtype: "init", apiKeySource: "none" });

async function rpc(body) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      authorization: env.CLAUDE_FAKE_BAD_TOKEN ? "Bearer " + "0".repeat(64) : `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

if (mode === "hang") {
  text("thinking");
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  out({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Not logged in"],
  });
  process.exit(1);
} else if (mode === "leak") {
  text(`the token is ${token}`);
  result();
} else if (mode === "tool") {
  const tool = env.CLAUDE_FAKE_TOOL;
  const args = JSON.parse(env.CLAUDE_FAKE_ARGS ?? "{}");
  out({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tu1", name: `mcp__boof__${tool}`, input: args }],
    },
  });
  const res = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  log({ rpcStatus: res.status, rpcBody: res.body.slice(0, 2000) });
  out({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "done", is_error: res.status !== 200 },
      ],
    },
  });
  text("Done.");
  result();
} else {
  text("Hello from fake claude.");
  result();
}
