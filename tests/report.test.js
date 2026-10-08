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
  assert.match(md, /Fewer than two reviewers finished/);
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
});
