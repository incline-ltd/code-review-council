import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentError, extractJson, findOnPath, resolveAgent, runAgent } from "../src/agents.js";
import { FINDINGS_SCHEMA } from "../src/prompts.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.js", import.meta.url));
const FINDING = { file: "a.js", line: 1, severity: "low", title: "t", explanation: "e" };

function fakeEnv(extra = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "crc-test-")), "calls.jsonl");
  const env = {
    ...process.env,
    CODE_REVIEW_COUNCIL_CLAUDE: FAKE,
    CODE_REVIEW_COUNCIL_CODEX: FAKE,
    CODE_REVIEW_COUNCIL_GEMINI: FAKE,
    FAKE_LOG: log,
    ...extra,
  };
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { env, calls };
}

async function call(agent, extra, options = {}) {
  const { env, calls } = fakeEnv(extra);
  const result = await runAgent(agent, {
    instruction: "review",
    input: "the diff",
    schema: FINDINGS_SCHEMA,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    env,
    ...options,
  });
  return { result, calls };
}

test("extractJson handles plain JSON, fences, and surrounding text", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.deepEqual(extractJson({ a: 1 }), { a: 1 });
  assert.throws(() => extractJson("no json here"), AgentError);
});

for (const agent of ["claude", "codex", "gemini"]) {
  test(`${agent}: returns structured findings and runs read-only`, async () => {
    const { result, calls } = await call(agent, { [`FAKE_REVIEW_${agent.toUpperCase()}`]: JSON.stringify([FINDING]) });
    assert.deepEqual(result.data, { findings: [FINDING] });
    const { argv } = calls()[0];
    const readOnly = {
      claude: ["--permission-mode", "dontAsk"],
      codex: ["--sandbox", "read-only"],
      gemini: ["--approval-mode", "plan"],
    }[agent];
    const at = argv.indexOf(readOnly[0]);
    assert.ok(at !== -1 && argv[at + 1] === readOnly[1], `${agent} must run with ${readOnly.join(" ")}`);
  });

  test(`${agent}: a failed run becomes an AgentError`, async () => {
    await assert.rejects(call(agent, { [`FAKE_FAIL_${agent.toUpperCase()}`]: "1" }), AgentError);
  });
}

test("claude cannot edit, run commands, or load the repo's settings and MCP servers", async () => {
  const { calls } = await call("claude", {});
  const argv = calls()[0].argv;
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(value("--tools"), "Read,Glob,Grep");
  assert.equal(value("--setting-sources"), "user");
  assert.ok(argv.includes("--strict-mcp-config"));
});

test("claude and codex receive the JSON schema", async () => {
  const claude = await call("claude", {});
  const claudeArgs = claude.calls()[0].argv;
  assert.deepEqual(JSON.parse(claudeArgs[claudeArgs.indexOf("--json-schema") + 1]), FINDINGS_SCHEMA);
  const codex = await call("codex", {});
  assert.ok(codex.calls()[0].argv.includes("--output-schema"));
});

test("a slow agent times out", async () => {
  await assert.rejects(call("claude", { FAKE_SLEEP_CLAUDE: "3000" }, { timeoutMs: 300 }), /timed out/);
});

test("finds executables on PATH and honors overrides", () => {
  assert.equal(findOnPath("definitely-not-a-real-binary", { PATH: "/nonexistent" }), null);
  assert.equal(resolveAgent("claude", { PATH: "", CODE_REVIEW_COUNCIL_CLAUDE: "/x/claude" }), "/x/claude");
  assert.equal(resolveAgent("unknown", {}), null);
});
