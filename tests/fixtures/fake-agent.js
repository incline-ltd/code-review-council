#!/usr/bin/env node
// Stands in for the claude, codex, and gemini CLIs in tests. It mimics each
// tool's documented output shape. Behavior comes from environment variables:
//   FAKE_REVIEW_<AGENT>  JSON array of findings to report
//   FAKE_VOTE_<AGENT>    verdict for every ballot item (default: confirm)
//   FAKE_FAIL_<AGENT>    exit non-zero
//   FAKE_SLEEP_<AGENT>   milliseconds to wait before answering
//   FAKE_LOG             file that receives one JSON line per call
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  if (process.env.FAKE_MCP_SLEEP) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_MCP_SLEEP)));
  const servers = JSON.parse(process.env.FAKE_MCP_SERVERS || "[]");
  for (const server of servers) {
    if (!process.env.FAKE_MCP_LOCKED && argv.some((arg) => arg.startsWith("mcp_servers={") && arg.includes(`${JSON.stringify(server.name)}={enabled=false}`))) server.enabled = false;
  }
  if (process.env.FAKE_MCP_LOG) {
    appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
  }
  process.stdout.write(process.env.FAKE_MCP_OUTPUT ?? JSON.stringify(servers));
  process.exit(0);
}
const agent = argv[0] === "exec" ? "codex" : argv.includes("--approval-mode") ? "gemini" : "claude";
const key = agent.toUpperCase();

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;

const voting = stdin.includes("<findings>");
if (process.env.FAKE_LOG) {
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ agent, argv, voting, cwd: process.cwd() }) + "\n");
}

const sleep = Number(process.env[`FAKE_SLEEP_${key}`] || 0);
if (sleep) await new Promise((r) => setTimeout(r, sleep));

if (process.env[`FAKE_FAIL_${key}`]) {
  if (agent === "claude") {
    process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }));
  } else {
    process.stderr.write("authentication required\n");
  }
  process.exit(1);
}

let reply;
if (voting) {
  const ballot = JSON.parse(stdin.split("<findings>")[1].split("</findings>")[0]);
  const verdict = process.env[`FAKE_VOTE_${key}`] || "confirm";
  reply = { votes: ballot.map((item) => ({ id: item.id, verdict, reason: `${agent} says ${verdict}` })) };
} else {
  reply = { findings: JSON.parse(process.env[`FAKE_REVIEW_${key}`] || "[]") };
}

if (agent === "claude") {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: reply }));
} else if (agent === "codex") {
  writeFileSync(argv[argv.indexOf("-o") + 1], process.env.FAKE_CODEX_REPLY_BYTES ? "x".repeat(Number(process.env.FAKE_CODEX_REPLY_BYTES)) : JSON.stringify(reply));
  process.stdout.write("done\n");
} else {
  process.stdout.write(JSON.stringify({ response: "```json\n" + JSON.stringify(reply) + "\n```", stats: {} }));
}
