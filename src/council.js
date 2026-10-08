import { diffStats, isAnchored, normalizePath, renderDiff } from "./diff.js";
import {
  FINDINGS_SCHEMA,
  REVIEW_INSTRUCTION,
  SEVERITIES,
  VOTE_INSTRUCTION,
  VOTES_SCHEMA,
  reviewPrompt,
  votePrompt,
} from "./prompts.js";
import { runAgent as defaultRunAgent } from "./agents.js";

const NEARBY_LINES = 2;
const MAX_FINDINGS_PER_REVIEWER = 10;

const rank = (severity) => SEVERITIES.indexOf(severity);

/** Give each seat a stable id. A repeated agent becomes `name#1`, `name#2`. */
export function seatReviewers(agents) {
  const counts = {};
  for (const a of agents) counts[a] = (counts[a] || 0) + 1;
  const seen = {};
  return agents.map((agent) => {
    seen[agent] = (seen[agent] || 0) + 1;
    return { id: counts[agent] > 1 ? `${agent}#${seen[agent]}` : agent, agent };
  });
}

function cleanFinding(raw, reviewer) {
  if (!raw || typeof raw !== "object") return null;
  const line = Number(raw.line);
  const severity = String(raw.severity || "").toLowerCase();
  if (!raw.file || !Number.isInteger(line) || !SEVERITIES.includes(severity) || !raw.title) return null;
  return {
    reviewer,
    file: normalizePath(raw.file),
    line,
    severity,
    title: String(raw.title).trim(),
    explanation: String(raw.explanation || "").trim(),
  };
}

/**
 * Group findings from different reviewers that point at the same place.
 * Two findings from the same reviewer are never merged.
 */
export function clusterFindings(findings) {
  const clusters = [];
  for (const f of findings) {
    let best = null;
    for (const c of clusters) {
      if (c.file !== f.file || c.authors.has(f.reviewer)) continue;
      const distance = Math.abs(c.line - f.line);
      if (distance <= NEARBY_LINES && (!best || distance < Math.abs(best.line - f.line))) best = c;
    }
    if (best) {
      best.findings.push(f);
      best.authors.add(f.reviewer);
      if (rank(f.severity) < rank(best.severity)) best.severity = f.severity;
    } else {
      clusters.push({
        file: f.file,
        line: f.line,
        severity: f.severity,
        title: f.title,
        explanation: f.explanation,
        findings: [f],
        authors: new Set([f.reviewer]),
        votes: [],
      });
    }
  }
  clusters.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  clusters.forEach((c, i) => (c.id = `F${i + 1}`));
  return clusters;
}

/** Decide each cluster: independent agreement plus confirm votes must reach minVotes and beat rejections. */
export function tally(clusters, minVotes) {
  for (const c of clusters) {
    const confirms = c.votes.filter((v) => v.verdict === "confirm").length;
    c.confirmations = c.authors.size + confirms;
    c.rejections = c.votes.filter((v) => v.verdict === "reject").length;
    c.confirmed = c.confirmations >= minVotes && c.confirmations > c.rejections;
  }
  return clusters;
}

/**
 * Run the council: independent reviews, a deterministic location check,
 * anonymous cross-votes on findings that lack independent agreement, then a tally.
 */
export async function runCouncil({
  files,
  reviewers,
  minVotes = 2,
  cwd,
  timeoutMs = 600_000,
  runAgent = defaultRunAgent,
  onProgress = () => {},
}) {
  const started = Date.now();
  const rendered = renderDiff(files);
  const seats = reviewers.map((r) => ({ ...r, ok: false, error: null, ms: 0, reported: 0, malformed: 0, unanchored: 0 }));

  // Stage 1: independent reviews in parallel.
  const reviews = await Promise.all(
    seats.map(async (seat) => {
      onProgress(`${seat.id}: reviewing`);
      try {
        const { data, ms } = await runAgent(seat.agent, {
          instruction: REVIEW_INSTRUCTION,
          input: reviewPrompt(rendered),
          schema: FINDINGS_SCHEMA,
          cwd,
          timeoutMs,
        });
        seat.ok = true;
        seat.ms = ms;
        const raw = Array.isArray(data?.findings) ? data.findings.slice(0, MAX_FINDINGS_PER_REVIEWER) : [];
        seat.reported = raw.length;
        const cleaned = raw.map((f) => cleanFinding(f, seat.id));
        seat.malformed = cleaned.filter((f) => !f).length;
        onProgress(`${seat.id}: ${raw.length} findings (${Math.round(ms / 1000)}s)`);
        return cleaned.filter(Boolean);
      } catch (error) {
        seat.error = error.message;
        onProgress(`${seat.id}: failed, ${error.message}`);
        return [];
      }
    }),
  );

  // Deterministic check: drop findings that cite a place outside the diff.
  const anchored = [];
  const unanchored = [];
  reviews.flat().forEach((f) => {
    if (isAnchored(files, f.file, f.line)) anchored.push(f);
    else {
      unanchored.push(f);
      seats.find((s) => s.id === f.reviewer).unanchored++;
    }
  });

  const clusters = clusterFindings(anchored);

  // Stage 2: each reviewer votes anonymously on findings it did not report.
  const needVotes = clusters.filter((c) => c.authors.size < minVotes);
  const voters = seats.filter((s) => s.ok);
  await Promise.all(
    voters.map(async (seat) => {
      const items = needVotes.filter((c) => !c.authors.has(seat.id));
      if (items.length === 0) return;
      onProgress(`${seat.id}: voting on ${items.length} findings`);
      const ballot = items.map(({ id, file, line, severity, title, explanation }) => ({
        id, file, line, severity, title, explanation,
      }));
      try {
        const { data } = await runAgent(seat.agent, {
          instruction: VOTE_INSTRUCTION,
          input: votePrompt(rendered, ballot),
          schema: VOTES_SCHEMA,
          cwd,
          timeoutMs,
        });
        const byId = new Map(items.map((c) => [c.id, c]));
        const counted = new Set();
        for (const v of Array.isArray(data?.votes) ? data.votes : []) {
          const cluster = byId.get(v?.id);
          if (!cluster || counted.has(v.id) || !["confirm", "reject", "unsure"].includes(v.verdict)) continue;
          counted.add(v.id);
          cluster.votes.push({ reviewer: seat.id, verdict: v.verdict, reason: String(v.reason || "").trim() });
        }
      } catch (error) {
        seat.voteError = error.message;
        onProgress(`${seat.id}: vote failed, ${error.message}`);
      }
    }),
  );

  tally(clusters, minVotes);
  const bySeverity = (a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line;
  return {
    reviewers: seats,
    minVotes,
    complete: voters.length >= 2,
    stats: diffStats(files),
    confirmed: clusters.filter((c) => c.confirmed).sort(bySeverity),
    unconfirmed: clusters.filter((c) => !c.confirmed).sort(bySeverity),
    unanchored,
    ms: Date.now() - started,
  };
}
