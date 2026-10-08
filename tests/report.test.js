import assert from "node:assert/strict";
import { test } from "node:test";
import { toJson, toMarkdown, toSarif } from "../src/report.js";

const cluster = (over) => ({
  id: "F1",
  file: "a.js",
  line: 4,
  severity: "medium",
  title: "Missing null check | on input",
  explanation: "input can be null.",
  findings: [],
  authors: new Set(["claude"]),
  votes: [],
  confirmations: 1,
  rejections: 0,
  ...over,
});

const result = {
  reviewers: [
    { id: "claude", ok: true },
    { id: "gemini", ok: false, error: "timed out after 600s" },
  ],
  minVotes: 2,
  complete: false,
  stats: { files: 1, additions: 3, deletions: 1 },
  confirmed: [cluster({ votes: [{ reviewer: "codex", verdict: "confirm", reason: "yes" }], confirmations: 2 })],
  unconfirmed: [cluster({ id: "F2", line: 9, severity: "low", title: "Maybe slow" })],
  unanchored: [{ file: "a.js", line: 99 }],
  ms: 75_000,
};

test("markdown shows confirmed findings, failures, and what was left out", () => {
  const md = toMarkdown(result);
  assert.match(md, /^## Code review council: 1 confirmed finding$/m);
  assert.match(md, /gemini \(failed: timed out after 600s\)/);
  assert.match(md, /Time: 1m 15s/);
  assert.match(md, /Review incomplete: fewer than 2 reviewers finished or a required vote failed/);
  assert.match(md, /\| 1 \| medium \| `a\.js:4` \| Missing null check \\\| on input \|/);
  assert.match(md, /Found by claude; confirmed by codex/);
  assert.match(md, /1 unconfirmed/);
  assert.match(md, /1 finding was dropped for citing a line outside the diff/);
});

test("json converts reviewer sets to arrays", () => {
  const parsed = JSON.parse(toJson(result));
  assert.deepEqual(parsed.confirmed[0].authors, ["claude"]);
});

test("sarif includes only confirmed findings", () => {
  const sarif = JSON.parse(toSarif(result, "0.1.0"));
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].level, "warning");
  assert.equal(sarif.runs[0].tool.driver.version, "0.1.0");
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
});

test("markdown renders model explanations as text instead of active links or HTML", () => {
  const md = toMarkdown({
    ...result,
    confirmed: [cluster({
      title: "[click](https://example.invalid) <img src=x>",
      explanation: "![secret](https://example.invalid/pixel)\n<script>alert(1)</script>",
    })],
  });
  assert.ok(!md.includes("<img"));
  assert.ok(!md.includes("<script>"));
  assert.ok(md.includes("\\!\\[secret\\]\\(https://example.invalid/pixel\\)"));
  assert.ok(md.includes("&lt;script&gt;"));
});

test("sarif URI-encodes filenames and preserves valid deleted-file line numbers", () => {
  const sarif = JSON.parse(toSarif({
    ...result,
    complete: true,
    confirmed: [cluster({ file: "src/removed #1.js", line: 1 })],
  }, "0.1.0"));
  const location = sarif.runs[0].results[0].locations[0].physicalLocation;
  assert.equal(location.artifactLocation.uri, "src/removed%20%231.js");
  assert.equal(location.region.startLine, 1);
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);
});

test("a failed vote remains visible in Markdown", () => {
  const md = toMarkdown({ ...result, reviewers: [{ id: "codex", ok: true, voteError: "missing votes" }] });
  assert.match(md, /codex \(vote failed: missing votes\)/);
});
