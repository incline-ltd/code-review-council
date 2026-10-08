import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTS, AgentError, exec, extractJson, findOnPath, resolveAgent, runAgent } from "../src/agents.js";
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
  assert.throws(() => extractJson("private-canary-content"), (error) => !error.message.includes("private-canary-content"));
});

for (const agent of ["claude", "codex"]) {
  test(`${agent}: returns structured findings and runs read-only`, async () => {
    const { result, calls } = await call(agent, { [`FAKE_REVIEW_${agent.toUpperCase()}`]: JSON.stringify([FINDING]) });
    assert.deepEqual(result.data, { findings: [FINDING] });
    const { argv } = calls()[0];
    const readOnly = {
      claude: ["--permission-mode", "dontAsk"],
      codex: ["--sandbox", "read-only"],
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
  assert.deepEqual(JSON.parse(value("--settings")), { disableAllHooks: true });
  assert.equal(value("--disallowedTools"), "mcp__*");
  assert.ok(argv.includes("--safe-mode"));
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(!argv.includes("--bare"), "bare mode would stop using OAuth login");
});

test("Gemini fails before starting a process, even when installed", async () => {
  const { env } = fakeEnv();
  assert.match(AGENTS.gemini.unsupported, /headless plan mode/);
  await assert.rejects(runAgent("gemini", { env }), /not supported in 0.1.0/);
  assert.ok(!existsSync(env.FAKE_LOG));
});

test("native Windows is rejected before starting an agent", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await assert.rejects(runAgent("claude", {}), /native Windows is not supported/);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("Codex excludes project config and verifies inherited MCP servers are disabled", async () => {
  const mcpLog = join(mkdtempSync(join(tmpdir(), "crc-mcp-test-")), "mcp.jsonl");
  const { calls } = await call("codex", {
    FAKE_MCP_LOG: mcpLog,
    FAKE_MCP_SERVERS: JSON.stringify([{ name: 'server.with."quotes"', enabled: true }]),
  });
  const [{ argv, cwd }] = calls();
  assert.notEqual(cwd, process.cwd());
  assert.ok(!existsSync(cwd), "temporary configuration directory is cleaned up");
  for (const flag of ["--skip-git-repo-check", "--ignore-rules"]) assert.ok(argv.includes(flag));
  for (const config of ['approval_policy="never"', 'web_search="disabled"', "allow_login_shell=false", "notify=[]"]) {
    assert.ok(argv.includes(config));
  }
  for (const feature of ["hooks", "plugins", "apps"]) {
    assert.ok(argv.some((arg, i) => arg === "--disable" && argv[i + 1] === feature));
  }
  assert.ok(!argv.includes("--add-dir"), "additional writable roots must not be granted");
  const probes = readFileSync(mcpLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((probe) => probe.cwd === cwd));
  const override = 'mcp_servers={"server.with.\\"quotes\\""={enabled=false}}';
  assert.ok(probes[1].argv.includes(override));
  assert.ok(argv.includes(override));
});

test("Codex does not review when MCP isolation cannot be verified", async () => {
  for (const extra of [
    { FAKE_MCP_OUTPUT: "not json" },
    { FAKE_MCP_OUTPUT: '[{"name":"unknown"}]' },
    { FAKE_MCP_SERVERS: '[{"name":"managed","enabled":true}]', FAKE_MCP_LOCKED: "1" },
  ]) {
    const { env } = fakeEnv(extra);
    await assert.rejects(runAgent("codex", {
      env, instruction: "review", input: "diff", schema: FINDINGS_SCHEMA,
      cwd: process.cwd(), timeoutMs: 10_000,
    }), /Codex MCP/);
    assert.ok(!existsSync(env.FAKE_LOG), "no model run on an isolation error");
  }
});

test("Codex preflight and review share one timeout budget", async () => {
  const started = Date.now();
  await assert.rejects(call("codex", {
    FAKE_MCP_SLEEP: "160", FAKE_SLEEP_CODEX: "1000",
  }, { timeoutMs: 500 }), /timed out/);
  assert.ok(Date.now() - started < 750, "the model call must not get a fresh 500ms budget");
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

test("a pre-aborted adapter or process never starts", async () => {
  const controller = new AbortController();
  controller.abort();
  const { env } = fakeEnv();
  await assert.rejects(runAgent("codex", { env, signal: controller.signal }), /interrupted/);
  await assert.rejects(exec("nonexistent-agent", [], { signal: controller.signal, timeoutMs: 1000 }), /interrupted/);
  assert.ok(!existsSync(env.FAKE_LOG));
});

test("canceling Codex preflight prevents the model call", async () => {
  const controller = new AbortController();
  const { env } = fakeEnv({ FAKE_MCP_SLEEP: "1000" });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(runAgent("codex", {
      env, signal: controller.signal, instruction: "review", input: "diff",
      schema: FINDINGS_SCHEMA, cwd: process.cwd(), timeoutMs: 5000,
    }), /interrupted/);
    assert.ok(!existsSync(env.FAKE_LOG));
  } finally {
    clearTimeout(timer);
  }
});

test("canceling a running adapter terminates its process", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    await assert.rejects(call("claude", { FAKE_SLEEP_CLAUDE: "5000" }, {
      signal: controller.signal, timeoutMs: 10_000,
    }), /interrupted/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(timer);
  }
});

test("a timeout stops descendants which inherit the agent's pipes", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crc-timeout-test-"));
  const marker = join(dir, "descendant-survived");
  const ready = join(dir, "ready");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1600); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','inherit','inherit']}); setInterval(() => {}, 1000);`;
  const result = await exec(process.execPath, ["-e", parent], { timeoutMs: 600 });
  assert.ok(existsSync(ready), "descendant ran before the timeout");
  assert.equal(result.timedOut, true);
  assert.ok(result.ms < 1600, `timeout returned after ${result.ms}ms`);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.ok(!existsSync(marker), "descendant cannot keep acting after the timeout");
});

test("output is bounded and excessive output stops the process", async () => {
  const result = await exec(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"], {
    timeoutMs: 10_000, maxOutputBytes: 1024,
  });
  assert.equal(result.outputExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  assert.ok(result.ms < 3000);
});

test("a process that ignores SIGTERM is forcibly stopped", async () => {
  const result = await exec(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(result.ms < 2500);
});

test("Codex reply files are bounded before loading them", async () => {
  await assert.rejects(call("codex", { FAKE_CODEX_REPLY_BYTES: String(4 * 1024 * 1024 + 1) }), /reply exceeded/);
});

test("finds executables on PATH and honors overrides", () => {
  assert.equal(findOnPath("definitely-not-a-real-binary", { PATH: "/nonexistent" }), null);
  assert.equal(resolveAgent("claude", { PATH: "", CODE_REVIEW_COUNCIL_CLAUDE: "/x/claude" }), "/x/claude");
  assert.equal(resolveAgent("unknown", {}), null);
});
