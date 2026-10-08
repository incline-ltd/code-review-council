import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/code-review-council.js", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.js", import.meta.url));

const ORIGINAL = `export function total(items) {
  let sum = 0;
  for (let i = 0; i < items.length; i++) sum += items[i].price;
  return sum;
}
`;
const CHANGED = `export function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) sum += items[i].price;
  return sum;
}
`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "crc-cli-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "cart.js"), ORIGINAL);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

const OFF_BY_ONE = JSON.stringify([
  { file: "cart.js", line: 3, severity: "high", title: "Loop reads past the end of items", explanation: "<= makes the last iteration read items[items.length], which is undefined." },
]);

function cli(dir, args, env = {}) {
  const log = join(dir, "..", `${Date.now()}-${Math.random()}.jsonl`);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      CODE_REVIEW_COUNCIL_CLAUDE: FAKE,
      CODE_REVIEW_COUNCIL_CODEX: FAKE,
      FAKE_LOG: log,
      ...env,
    },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {}
  return { ...result, calls };
}

test("reports a bug that two reviewers find independently", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "cart.js"), CHANGED);
  const out = cli(dir, ["--agents", "claude,codex"], { FAKE_REVIEW_CLAUDE: OFF_BY_ONE, FAKE_REVIEW_CODEX: OFF_BY_ONE });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /1 confirmed finding/);
  assert.match(out.stdout, /`cart\.js:3`/);
  assert.match(out.stdout, /Found independently by claude, codex/);
  assert.equal(out.calls.filter((c) => c.voting).length, 0);
  assert.ok(out.calls.every((c) => c.cwd === out.calls[0].cwd));
});

test("a finding only one reviewer reports goes to a vote", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "cart.js"), CHANGED);
  const out = cli(dir, ["--agents", "claude,codex", "--format", "json"], {
    FAKE_REVIEW_CLAUDE: OFF_BY_ONE,
    FAKE_VOTE_CODEX: "reject",
  });
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.equal(report.confirmed.length, 0);
  assert.equal(report.unconfirmed[0].votes[0].verdict, "reject");
  assert.deepEqual(out.calls.filter((c) => c.voting).map((c) => c.agent), ["codex"]);
});

test("--fail-on exits 1 and sarif lists confirmed findings", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "cart.js"), CHANGED);
  const env = { FAKE_REVIEW_CLAUDE: OFF_BY_ONE, FAKE_REVIEW_CODEX: OFF_BY_ONE };
  const out = cli(dir, ["--agents", "claude,codex", "--format", "sarif", "--fail-on", "high"], env);
  assert.equal(out.status, 1);
  const sarif = JSON.parse(out.stdout);
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results[0].level, "error");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 3);
});

test("--base reviews committed work on a branch", () => {
  const { dir, git } = repo();
  git("switch", "-q", "-c", "feature");
  writeFileSync(join(dir, "cart.js"), CHANGED);
  git("commit", "-q", "-am", "change");
  const out = cli(dir, ["--agents", "claude,codex", "--base", "main"], { FAKE_REVIEW_CLAUDE: OFF_BY_ONE, FAKE_REVIEW_CODEX: OFF_BY_ONE });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /1 confirmed finding/);
});

test("no changes means no agent calls", () => {
  const { dir } = repo();
  const out = cli(dir, ["--agents", "claude,codex"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /No changes to review/);
  assert.equal(out.calls.length, 0);
});

test("all reviewers failing exits 2", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "cart.js"), CHANGED);
  const out = cli(dir, ["--agents", "claude,codex"], { FAKE_FAIL_CLAUDE: "1", FAKE_FAIL_CODEX: "1" });
  assert.equal(out.status, 2);
  assert.match(out.stdout, /failed/);
});

test("usage errors exit 2", () => {
  const { dir } = repo();
  assert.equal(cli(dir, ["--format", "html"]).status, 2);
  assert.equal(cli(dir, ["--agents", "nope"]).status, 2);
  assert.equal(cli(dir, ["--min-votes", "0"]).status, 2);
  assert.equal(cli(dir, ["--agents", "claude", "--min-votes", "2"]).status, 2);
});
