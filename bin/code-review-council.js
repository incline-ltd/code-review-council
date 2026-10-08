#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AGENTS, resolveAgent } from "../src/agents.js";
import { runCouncil, seatReviewers } from "../src/council.js";
import { collectDiff, diffStats } from "../src/diff.js";
import { SEVERITIES } from "../src/prompts.js";
import { toJson, toMarkdown, toSarif } from "../src/report.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const HELP = `code-review-council ${version}

Review your changes with the coding-agent CLIs you already have installed.
Each agent reviews independently; only findings a second reviewer confirms
are reported.

Usage: code-review-council [options]

Options:
  --base <ref>          Review everything since the merge base with <ref>
                        (default: uncommitted changes against HEAD)
  --agents <list>       Comma-separated: ${Object.keys(AGENTS).join(",")} (default: all installed)
  --min-votes <n>       Reviewers that must agree on a finding (default: 2)
  --format <format>     markdown, json, or sarif (default: markdown)
  --out <file>          Write the report to a file instead of stdout
  --fail-on <severity>  Exit 1 if a confirmed finding is at least high, medium, or low
  --timeout <seconds>   Limit for each agent call (default: 600)
  --max-lines <n>       Refuse diffs with more changed lines (default: 3000)
  --list-agents         Show which agent CLIs were found and exit
  -h, --help            Show this help
  -v, --version         Show the version

Exit codes: 0 done, 1 --fail-on matched, 2 usage error or no reviewer finished.
`;

function fail(message) {
  process.stderr.write(`code-review-council: ${message}\n`);
  process.exit(2);
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer`);
  return n;
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      base: { type: "string" },
      agents: { type: "string" },
      "min-votes": { type: "string", default: "2" },
      format: { type: "string", default: "markdown" },
      out: { type: "string" },
      "fail-on": { type: "string" },
      timeout: { type: "string", default: "600" },
      "max-lines": { type: "string", default: "3000" },
      "list-agents": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  }));
} catch (error) {
  fail(error.message);
}

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

const installed = Object.keys(AGENTS).filter((name) => resolveAgent(name));

if (args["list-agents"]) {
  for (const name of Object.keys(AGENTS)) {
    process.stdout.write(`${name.padEnd(7)} ${resolveAgent(name) || "not found"}\n`);
  }
  process.exit(0);
}

const formats = { markdown: toMarkdown, json: toJson, sarif: (r) => toSarif(r, version) };
if (!formats[args.format]) fail(`unknown --format ${args.format}`);
if (args["fail-on"] && !SEVERITIES.includes(args["fail-on"])) fail(`--fail-on must be one of ${SEVERITIES.join(", ")}`);
const minVotes = positiveInt(args["min-votes"], "min-votes");
const timeoutMs = positiveInt(args.timeout, "timeout") * 1000;
const maxLines = positiveInt(args["max-lines"], "max-lines");

let agents;
if (args.agents) {
  agents = args.agents.split(",").map((a) => a.trim()).filter(Boolean);
  for (const name of agents) {
    if (!AGENTS[name]) fail(`unknown agent "${name}"`);
    if (!resolveAgent(name)) fail(`${name} is not installed or not on PATH`);
  }
} else if (installed.length === 0) {
  fail("no agent CLI found. Install Claude Code, Codex, or Gemini CLI first (see --list-agents)");
} else if (installed.length === 1) {
  // One agent alone cannot cross-check; two separate sessions of it can.
  agents = [installed[0], installed[0]];
  process.stderr.write(`Only ${installed[0]} is installed; running it as two independent reviewers.\n`);
} else {
  agents = installed;
}
if (agents.length < minVotes) {
  fail(`--min-votes ${minVotes} needs at least ${minVotes} reviewers. To use one agent twice, repeat it: --agents ${agents[0]},${agents[0]}`);
}

let diff;
try {
  diff = await collectDiff({ cwd: process.cwd(), base: args.base });
} catch (error) {
  fail(`could not read the git diff: ${String(error.stderr || error.message).trim()}`);
}

const stats = diffStats(diff.files);
if (stats.files === 0) {
  process.stdout.write("No changes to review.\n");
  process.exit(0);
}
if (stats.additions + stats.deletions > maxLines) {
  fail(`the diff has ${stats.additions + stats.deletions} changed lines (limit ${maxLines}). Review a smaller range or raise --max-lines`);
}

const result = await runCouncil({
  files: diff.files,
  reviewers: seatReviewers(agents),
  minVotes,
  cwd: diff.root,
  timeoutMs,
  onProgress: (message) => process.stderr.write(`  ${message}\n`),
});

const report = formats[args.format](result);
if (args.out) writeFileSync(args.out, report.endsWith("\n") ? report : report + "\n");
else process.stdout.write(report.endsWith("\n") ? report : report + "\n");

if (!result.reviewers.some((r) => r.ok)) process.exit(2);
if (!result.complete) process.stderr.write("Warning: fewer than two reviewers finished; nothing was cross-confirmed.\n");
if (args["fail-on"]) {
  const limit = SEVERITIES.indexOf(args["fail-on"]);
  if (result.confirmed.some((c) => SEVERITIES.indexOf(c.severity) <= limit)) process.exit(1);
}
