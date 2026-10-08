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

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
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
    .map((r) => (r.ok ? r.id : `${r.id} (failed: ${oneLine(r.error)})`))
    .join(", ");
  out.push(
    `Reviewers: ${seats}. Diff: ${plural(stats.files, "file")}, +${stats.additions} -${stats.deletions}. ` +
      `Time: ${seconds(result.ms)}. A finding needs ${result.minVotes} reviewers to agree.`,
    "",
  );
  if (!result.complete) {
    out.push("> Fewer than two reviewers finished, so nothing could be cross-confirmed.", "");
  }

  if (count) {
    out.push("| # | Severity | Location | Finding |", "| --- | --- | --- | --- |");
    confirmed.forEach((c, i) => {
      out.push(`| ${i + 1} | ${c.severity} | \`${c.file}:${c.line}\` | ${oneLine(c.title)} |`);
    });
    out.push("");
    confirmed.forEach((c, i) => {
      out.push(`### ${i + 1}. ${oneLine(c.title)}`, "");
      out.push(`\`${c.file}:${c.line}\`, ${c.severity}. ${capitalize(support(c))}.`, "");
      if (c.explanation) out.push(c.explanation, "");
    });
  } else {
    out.push("No finding was confirmed by a second reviewer.", "");
  }

  if (unconfirmed.length) {
    out.push(`<details><summary>${unconfirmed.length} unconfirmed (reported by one reviewer, not confirmed)</summary>`, "");
    for (const c of unconfirmed) {
      out.push(`- \`${c.file}:${c.line}\` ${c.severity}: ${oneLine(c.title)} (${support(c)})`);
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
          results: result.confirmed.map((c) => ({
            ruleId: "confirmed-finding",
            level: LEVELS[c.severity],
            message: { text: `${c.title}\n\n${c.explanation}\n\n${capitalize(support(c))}.` },
            locations: [
              { physicalLocation: { artifactLocation: { uri: c.file }, region: { startLine: c.line } } },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}
