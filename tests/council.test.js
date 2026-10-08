import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentError } from "../src/agents.js";
import { clusterFindings, runCouncil, seatReviewers } from "../src/council.js";
import { parseDiff } from "../src/diff.js";

const FILES = parseDiff(`diff --git a/src/pay.js b/src/pay.js
index 1..2 100644
--- a/src/pay.js
+++ b/src/pay.js
@@ -10,6 +10,8 @@
 a
 b
-c
+c2
+c3
+c4
 d
 e
`);

const finding = (line, title = "Bug", severity = "high") => ({
  file: "src/pay.js",
  line,
  severity,
  title,
  explanation: `${title} explanation`,
});

/** A scripted stand-in for runAgent: reviews and votes come from tables keyed by agent. */
function scripted({ reviews = {}, votes = {}, fail = {} }) {
  const calls = [];
  const runAgent = async (agent, { input }) => {
    const voting = input.includes("<findings>");
    calls.push({ agent, voting });
    if (fail[agent]) throw new AgentError(fail[agent]);
    if (voting) {
      const ballot = JSON.parse(input.split("<findings>")[1].split("</findings>")[0]);
      return { data: { votes: ballot.map((b) => ({ id: b.id, verdict: votes[agent] || "unsure", reason: "r" })) }, ms: 1 };
    }
    return { data: { findings: reviews[agent] || [] }, ms: 1 };
  };
  return { runAgent, calls };
}

const council = (options) =>
  runCouncil({ files: FILES, reviewers: seatReviewers(options.agents), minVotes: 2, ...options });

test("seats repeated agents as separate reviewers", () => {
  assert.deepEqual(seatReviewers(["claude", "claude", "codex"]).map((s) => s.id), ["claude#1", "claude#2", "codex"]);
});

test("identical independent claims confirm without a vote", async () => {
  const { runAgent, calls } = scripted({ reviews: { claude: [finding(12)], codex: [finding(12, "Bug", "medium")] } });
  const result = await council({ agents: ["claude", "codex"], runAgent });
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.confirmed[0].confirmations, 2);
  assert.equal(result.confirmed[0].severity, "high", "keeps the most severe rating");
  assert.equal(calls.filter((c) => c.voting).length, 0);
});

test("a single report needs a confirming vote from another reviewer", async () => {
  const confirm = scripted({ reviews: { claude: [finding(12)] }, votes: { codex: "confirm" } });
  const confirmed = await council({ agents: ["claude", "codex"], runAgent: confirm.runAgent });
  assert.equal(confirmed.confirmed.length, 1);
  assert.deepEqual(confirm.calls.filter((c) => c.voting).map((c) => c.agent), ["codex"], "authors do not vote on their own finding");

  const reject = scripted({ reviews: { claude: [finding(12)] }, votes: { codex: "reject" } });
  const rejected = await council({ agents: ["claude", "codex"], runAgent: reject.runAgent });
  assert.equal(rejected.confirmed.length, 0);
  assert.equal(rejected.unconfirmed[0].rejections, 1);
});

test("rejections must not outnumber confirmations", async () => {
  const { runAgent } = scripted({
    reviews: { claude: [finding(12)] },
    votes: { codex: "confirm", gemini: "reject" },
  });
  const result = await council({ agents: ["claude", "codex", "gemini"], runAgent, minVotes: 2 });
  assert.equal(result.confirmed.length, 1, "2 confirmations beat 1 rejection");

  const tie = scripted({ reviews: { claude: [finding(12)] }, votes: { codex: "reject", gemini: "reject" } });
  const tied = await council({ agents: ["claude", "codex", "gemini"], runAgent: tie.runAgent });
  assert.equal(tied.confirmed.length, 0);
});

test("findings outside the diff are dropped before voting", async () => {
  const { runAgent, calls } = scripted({ reviews: { claude: [finding(40)], codex: [finding(40)] } });
  const result = await council({ agents: ["claude", "codex"], runAgent });
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.unanchored.length, 2);
  assert.equal(result.reviewers[0].unanchored, 1);
  assert.equal(calls.filter((c) => c.voting).length, 0);
});

test("malformed findings are counted and fail the review", async () => {
  const { runAgent } = scripted({
    reviews: { claude: [finding(12), { file: "src/pay.js", line: "x" }, { line: 12 }, null], codex: [finding(12)] },
  });
  const result = await council({ agents: ["claude", "codex"], runAgent });
  assert.equal(result.reviewers[0].malformed, 3);
  assert.equal(result.reviewers[0].ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.confirmed.length, 0);
});

test("a failed reviewer leaves the council incomplete", async () => {
  const { runAgent } = scripted({ reviews: { claude: [finding(12)] }, fail: { codex: "codex is not installed" } });
  const result = await council({ agents: ["claude", "codex"], runAgent });
  assert.equal(result.complete, false);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.unconfirmed.length, 1);
  assert.equal(result.reviewers[1].error, "codex is not installed");
});

test("canceling a three-reviewer run prevents successful reviewers from starting new votes", async () => {
  const controller = new AbortController();
  const calls = [];
  let slowStarted;
  const started = new Promise((resolve) => { slowStarted = resolve; });
  const runAgent = async (agent, { input, signal }) => {
    calls.push({ agent, voting: input.includes("<findings>") });
    assert.equal(signal, controller.signal);
    if (agent === "slow") {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new AgentError("interrupted")), { once: true });
        slowStarted();
      });
    }
    return { data: { findings: agent === "claude" ? [finding(12)] : [] }, ms: 1 };
  };
  const pending = council({ agents: ["claude", "codex", "slow"], runAgent, signal: controller.signal });
  await started;
  // Let the two successful reviewers finish before interrupting the third.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.reviewers.filter((reviewer) => reviewer.ok).length, 2);
  assert.equal(calls.filter((call) => !call.voting).length, 3);
  assert.equal(calls.filter((call) => call.voting).length, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.complete, false);
});

test("a pre-canceled council starts no agent calls", async () => {
  const controller = new AbortController();
  controller.abort();
  const { runAgent, calls } = scripted({});
  const result = await council({ agents: ["claude", "codex"], runAgent, signal: controller.signal });
  assert.equal(calls.length, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.complete, false);
});

test("cancellation between review and voting starts no ballot calls", async () => {
  const controller = new AbortController();
  const { runAgent, calls } = scripted({ reviews: { claude: [finding(12)] } });
  const result = await council({
    agents: ["claude", "codex"], runAgent, signal: controller.signal,
    onProgress(message) { if (message.includes(": voting")) controller.abort(); },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.aborted, true);
  assert.equal(result.complete, false);
});

test("findings from the same reviewer are never merged", () => {
  const clusters = clusterFindings([
    { ...finding(12, "A"), reviewer: "claude" },
    { ...finding(13, "B"), reviewer: "claude" },
    { ...finding(13, "C"), reviewer: "codex" },
  ]);
  assert.equal(clusters.length, 3);
  assert.deepEqual(clusters.map((c) => [...c.authors]), [["claude"], ["claude"], ["codex"]]);
});

test("unrelated claims on adjacent or identical lines need explicit cross-votes", async () => {
  for (const line of [12, 13]) {
    const { runAgent, calls } = scripted({
      reviews: { claude: [finding(12, "SQL injection")], codex: [finding(line, "Loop exceeds array bounds")] },
      votes: { claude: "reject", codex: "reject" },
    });
    const result = await council({ agents: ["claude", "codex"], runAgent });
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.unconfirmed.length, 2);
    assert.equal(calls.filter((call) => call.voting).length, 2);
  }
});

test("a missing findings array is a failed review, not an empty review", async () => {
  const result = await council({ agents: ["claude", "codex"], runAgent: async () => ({ data: {}, ms: 1 }) });
  assert.equal(result.complete, false);
  assert.ok(result.reviewers.every((reviewer) => !reviewer.ok));
});

test("completion requires the configured quorum", async () => {
  const { runAgent } = scripted({ fail: { gemini: "unavailable" } });
  const result = await council({ agents: ["claude", "codex", "gemini"], minVotes: 3, runAgent });
  assert.equal(result.complete, false);
});

test("missing votes fail the ballot instead of silently dropping findings", async () => {
  const result = await council({
    agents: ["claude", "codex"],
    runAgent: async (agent, { input }) => ({
      data: input.includes("<findings>") ? { votes: [] } : { findings: agent === "claude" ? [finding(12)] : [] },
      ms: 1,
    }),
  });
  assert.equal(result.complete, false);
  assert.equal(result.confirmed.length, 0);
  assert.match(result.reviewers[1].voteError, /every finding/);
});

test("a numeric string, zero line, or blank claim is malformed", async () => {
  for (const invalid of [{ ...finding(12), line: "12" }, finding(0), finding(12, " "), { ...finding(12), explanation: "" }]) {
    const { runAgent } = scripted({ reviews: { claude: [invalid] } });
    const result = await council({ agents: ["claude", "codex"], runAgent });
    assert.equal(result.reviewers[0].ok, false);
    assert.equal(result.reviewers[0].malformed, 1);
  }
});

test("ignores votes for unknown ids and duplicate votes", async () => {
  const runAgent = async (agent, { input }) => {
    if (!input.includes("<findings>")) return { data: { findings: agent === "claude" ? [finding(12)] : [] }, ms: 1 };
    return {
      data: {
        votes: [
          { id: "F1", verdict: "confirm", reason: "real" },
          { id: "F1", verdict: "confirm", reason: "again" },
          { id: "F9", verdict: "confirm", reason: "unknown" },
          { id: "F1", verdict: "maybe", reason: "bad verdict" },
        ],
      },
      ms: 1,
    };
  };
  const result = await council({ agents: ["claude", "codex"], runAgent, minVotes: 3 });
  assert.equal(result.unconfirmed[0].votes.length, 1);
  assert.equal(result.unconfirmed[0].confirmations, 2);
});
