function seconds(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function markdown(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#!|~])/g, "\\$1");
}

function oneLine(text) {
  return markdown(String(text).replace(/\s+/g, " ").trim());
}

function location(c) {
  const text = `${c.file}:${c.line}`.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text.replace(/\|/g, "\\|")}${pad}${fence}`;
}

function support(c) {
  const independent = [...c.authors];
  const confirms = c.votes.filter((v) => v.verdict === "confirm").map((v) => v.reviewer);
  const parts = [];
  if (independent.length > 1) parts.push(`found independently by ${independent.join(", ")}`);
  else parts.push(`found by ${independent[0]}`);
  if (confirms.length) parts.push(`confirmed by ${confirms.join(", ")}`);
  const rejects = c.votes.filter((v) => v.verdict === "reject").map((v) => v.reviewer);
  if (rejects.length) parts.push(`rejected by ${rejects.join(", ")}`);
  return parts.join("; ");
}

export function toMarkdown(result) {
  const { confirmed, unconfirmed, unanchored, reviewers, stats } = result;
  const out = [];
  const count = confirmed.length;
  out.push(`## Code review council: ${plural(count, "confirmed finding")}`, "");

  const seats = reviewers
    .map((r) => (r.ok ? `${r.id}${r.voteError ? ` (vote failed: ${oneLine(r.voteError)})` : ""}` : `${r.id} (failed: ${oneLine(r.error)})`))
    .join(", ");
  out.push(
    `Reviewers: ${seats}. Diff: ${plural(stats.files, "file")}, +${stats.additions} -${stats.deletions}. ` +
      `Time: ${seconds(result.ms)}. A finding needs ${result.minVotes} reviewers to agree.`,
    "",
  );
  if (!result.complete) {
    out.push(`> Review incomplete: fewer than ${result.minVotes} reviewers finished or a required vote failed.`, "");
  }

  if (count) {
    out.push("| # | Severity | Location | Finding |", "| --- | --- | --- | --- |");
    confirmed.forEach((c, i) => {
      out.push(`| ${i + 1} | ${c.severity} | ${location(c)} | ${oneLine(c.title)} |`);
    });
    out.push("");
    confirmed.forEach((c, i) => {
      out.push(`### ${i + 1}. ${oneLine(c.title)}`, "");
      out.push(`${location(c)}, ${c.severity}. ${capitalize(support(c))}.`, "");
      if (c.explanation) out.push(markdown(c.explanation), "");
    });
  } else {
    out.push(`No finding reached the required support of ${result.minVotes} reviewers.`, "");
  }

  if (unconfirmed.length) {
    out.push(`<details><summary>${unconfirmed.length} unconfirmed (required agreement not reached)</summary>`, "");
    for (const c of unconfirmed) {
      out.push(`- ${location(c)} ${c.severity}: ${oneLine(c.title)} (${support(c)})`);
    }
    out.push("", "</details>", "");
  }
  if (unanchored.length) {
    const n = unanchored.length;
    out.push(`${plural(n, "finding")} ${n === 1 ? "was" : "were"} dropped for citing a line outside the diff.`, "");
  }
  return out.join("\n");
}

function plain(cluster) {
  const { authors, ...rest } = cluster;
  return { ...rest, authors: [...authors] };
}

export function toJson(result) {
  return JSON.stringify(
    {
      ...result,
      confirmed: result.confirmed.map(plain),
      unconfirmed: result.unconfirmed.map(plain),
    },
    null,
    2,
  );
}

const LEVELS = { high: "error", medium: "warning", low: "note" };

/** SARIF 2.1.0 with confirmed findings only, for code scanning tools. */
export function toSarif(result, version) {
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "code-review-council",
              version,
              informationUri: "https://github.com/incline-ltd/code-review-council",
              rules: [{ id: "confirmed-finding", shortDescription: { text: "Finding confirmed by the review council" } }],
            },
          },
          invocations: [{ executionSuccessful: result.complete }],
          results: result.confirmed.map((c) => ({
            ruleId: "confirmed-finding",
            level: LEVELS[c.severity],
            message: { text: `${c.title}\n\n${c.explanation}\n\n${capitalize(support(c))}.` },
            locations: [
              { physicalLocation: { artifactLocation: { uri: c.file.split("/").map(encodeURIComponent).join("/") }, region: { startLine: c.line } } },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}
