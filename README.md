# Code Review Council

[![CI](https://github.com/incline-ltd/code-review-council/actions/workflows/ci.yml/badge.svg)](https://github.com/incline-ltd/code-review-council/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A code review council for the coding agents you already have.**

Claude Code, Codex, and Gemini CLI review your change independently. A finding
is reported only when a second reviewer agrees with it. No API key: it runs
the agent CLIs you are already signed in to.

[How it works](#how-it-works) · [Quick start](#quick-start) ·
[Example report](examples/sample-report.md) · [Benchmark](docs/benchmark.md) ·
[Safety](#safety)

## Why

One AI reviewer is noisy. It flags style, invents problems, and cites the
wrong line, so people stop reading its comments. Inspired by Andrej Karpathy's
[llm-council](https://github.com/karpathy/llm-council), this asks several
agents and keeps only what they agree on.

## How it works

1. **Review.** Each agent reviews the diff on its own, read-only, with access
   to the whole repository.
2. **Check.** Findings that cite a file or line outside the diff are dropped.
   This step is code, not a model.
3. **Vote.** A finding reported by only one agent goes to the others,
   anonymously, to confirm or reject.
4. **Report.** A finding is confirmed when at least two reviewers support it
   and support beats rejection. Everything else is listed as unconfirmed.

There is no "chairman" model rewriting the result. The tally is deterministic.

## Quick start

Requires Node.js 20+, Git, and at least one of
[Claude Code](https://code.claude.com/docs/en/overview),
[Codex](https://github.com/openai/codex), or
[Gemini CLI](https://github.com/google-gemini/gemini-cli), signed in.

```bash
git clone https://github.com/incline-ltd/code-review-council.git
cd your-project
node ../code-review-council/bin/code-review-council.js --list-agents
node ../code-review-council/bin/code-review-council.js              # uncommitted changes
node ../code-review-council/bin/code-review-council.js --base main  # the whole branch
```

No dependencies and no build step. With only one agent installed, it runs that
agent as two independent reviewers. The npm package is not published yet.

To use it from Claude Code or Codex, copy
[`skills/code-review-council`](skills/code-review-council/SKILL.md) into your
skills directory and ask for a council review.

## Example

```text
## Code review council: 2 confirmed findings

| # | Severity | Location    | Finding                          |
| 1 | high     | `cart.js:3` | Loop reads one item past the end |
| 2 | medium   | `cart.js:4` | Discount is not bounded          |

### 1. Loop reads one item past the end
`cart.js:3`, high. Found independently by claude, codex.

### 2. Discount is not bounded
`cart.js:4`, medium. Found by claude; confirmed by codex.

1 unconfirmed (reported by one reviewer, not confirmed)
1 finding was dropped for citing a line outside the diff.
```

This is the real report format. The reviewers in the
[full example](examples/sample-report.md) are the scripted test agents, so
the findings are illustrative, not a model's review.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--base <ref>` | uncommitted changes | Review everything since the merge base with `<ref>` |
| `--agents <list>` | all installed | `claude`, `codex`, `gemini`; repeat one to run it twice |
| `--min-votes <n>` | `2` | Reviewers that must support a finding |
| `--format <format>` | `markdown` | `markdown`, `json`, or `sarif` for code-scanning tools |
| `--out <file>` | stdout | Write the report to a file |
| `--fail-on <severity>` | off | Exit 1 if a confirmed finding is at least `high`, `medium`, or `low` |
| `--timeout <seconds>` | `600` | Limit for each agent call |
| `--max-lines <n>` | `3000` | Refuse larger diffs |

Exit codes: `0` done, `1` `--fail-on` matched, `2` usage error or no reviewer
finished. Untracked files are not part of `git diff`; stage new files first.

## How it differs

[open-code-review](https://github.com/alibaba/open-code-review) and
[rcl](https://github.com/allocator-one/rcl) call model APIs with keys you
configure. This tool drives the agent CLIs you already use, under whatever
login each one has, and lets each agent read the repository with its own
tools. Whether that reviews better is a question for the benchmark.

## Benchmark

Not run yet. The plan is to score the council on
[AACR-Bench](https://github.com/alibaba/aacr-bench), the 200-PR benchmark
open-code-review reports against, using its official pipeline next to
single-agent Claude Code and Codex. The result will be published whatever it
shows. See the [benchmark plan](docs/benchmark.md).

## Safety

- Agents run read-only. Claude Code gets only its Read, Glob, and Grep tools
  with `--permission-mode dontAsk`; Codex runs with `--sandbox read-only`;
  Gemini CLI runs in its read-only plan mode.
- Claude Code loads only your user settings and no MCP servers from the
  reviewed repository, so that repository's project hooks and permission rules
  do not run. Codex and Gemini CLI apply their own project-trust rules; check
  them before reviewing code you do not trust.
- Prompts mark the diff as untrusted data. That reduces prompt injection from
  the code under review but cannot rule it out.
- Every agent still reads the repository's instruction files, such as
  `AGENTS.md` and `CLAUDE.md`, as context. For untrusted code, run inside a
  container.
- This tool makes no network calls and collects no telemetry. Your agents send
  the diff, and any files they read, to their providers as in normal use.
- Usage: each agent runs once to review and at most once to vote.

## Status

Preview, version 0.1.0. Adapters follow each tool's official headless
documentation and are tested against a scripted fake agent.

| Agent | Adapter tests | Live run |
| --- | --- | --- |
| Claude Code | Passed | Flags checked against 2.1.289 `--help`; review run pending |
| Codex | Passed | Passed on 0.162.0-alpha.2: two sessions found and confirmed a planted bug in 25s. Vote step not yet exercised live |
| Gemini CLI | Passed | Pending |

Live-run reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Related Incline projects

- [Coding Agent Guidelines](https://github.com/incline-ltd/coding-agent-guidelines): short rules for small, verified changes by coding agents.
- [Agent Cost Guard](https://github.com/incline-ltd/agent-cost-guard): a local hook that stops cloud-cost commands until a person approves.
- [Awesome Agentic Engineering](https://github.com/incline-ltd/awesome-agentic-engineering): a reviewed guide to coding-agent tools.

## License

[MIT](LICENSE)
