# Code Review Council

[![CI](https://github.com/incline-ltd/code-review-council/actions/workflows/ci.yml/badge.svg)](https://github.com/incline-ltd/code-review-council/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A code review council for the coding agents you already have.**

Claude Code and Codex review your change independently. A finding is confirmed
only when at least two reviewers support it. The tool uses your existing CLI
logins and requires no additional API key. Gemini support is disabled in this
preview while its read-only restrictions are being verified.

[How it works](#how-it-works) · [Quick start](#quick-start) ·
[Example report](examples/sample-report.md) · [Benchmark](docs/benchmark.md) ·
[Safety](#safety)

## Why

One AI reviewer is noisy. It flags style, invents problems, and cites the
wrong line, so people stop reading its comments. Inspired by Andrej Karpathy's
[llm-council](https://github.com/karpathy/llm-council), this asks several
agents and keeps only what they agree on.

## How it works

1. **Review.** Each agent reviews the diff in a separate session, with
   read-only tools and access to repository context.
2. **Check.** Findings that cite a file or line outside the diff are dropped.
   This step is code, not a model.
3. **Vote.** Matching file, line, title and explanation count as independent
   agreement. Every other finding goes to the remaining reviewers anonymously
   to confirm, reject or mark unsure.
4. **Report.** A finding is confirmed when at least two reviewers support it
   and support beats rejection. Everything else is listed as unconfirmed.

The tally is deterministic. Location proximity alone never counts as agreement.
Differently worded reports of the same bug can remain separate after voting.
Two sessions of one model are a cross-check, not independent evidence of accuracy.

## Quick start

Requires Node.js 20+, Git, macOS or Linux, and at least one of
[Claude Code](https://code.claude.com/docs/en/overview) or
[Codex](https://github.com/openai/codex), signed in. See the tested versions below.
Use the tested CLI versions below. Missing flags or failed MCP configuration
checks stop the review; future CLI behavior and configuration changes need
fresh verification.

```bash
npm install -g git+https://github.com/incline-ltd/code-review-council.git#v0.1.0
cd your-project
code-review-council --list-agents
code-review-council              # uncommitted changes
code-review-council --base main  # the whole branch
```

This installs the tagged GitHub release directly. No npm account is needed.
There are no dependencies and no build step. With one supported agent installed,
it runs that agent as two separate reviewers. To skip installation, clone this
repository and run `node <checkout>/bin/code-review-council.js` from your project.

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

1 unconfirmed (required agreement not reached)
1 finding was dropped for citing a line outside the diff.
```

This example is shortened for readability. The reviewers in the
[full example](examples/sample-report.md) are the scripted test agents, so
the findings are illustrative, not a model's review.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--base <ref>` | uncommitted changes | Review everything since the merge base with `<ref>` |
| `--agents <list>` | all supported installed agents | `claude`, `codex`; repeat one to run it twice |
| `--min-votes <n>` | `2` | Reviewers that must support a finding, minimum 2 |
| `--format <format>` | `markdown` | `markdown`, `json`, or `sarif` for code-scanning tools |
| `--out <file>` | stdout | Write the report to a file |
| `--fail-on <severity>` | off | Exit 1 if a confirmed finding is at least `high`, `medium`, or `low` |
| `--timeout <seconds>` | `600` | Limit for each agent call |
| `--max-lines <n>` | `3000` | Refuse larger diffs |

Exit codes: `0` complete, `1` `--fail-on` matched, `2` usage error or incomplete
review, including missing quorum or a failed required vote; `130` cancelled.
Binary files and common generated lockfiles are skipped. A clean report does
not prove the change is bug-free. Untracked files are not part of `git diff`;
stage new files first.

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

- Claude gets only Read, Glob and Grep, with approvals, hooks, MCP tools and
  session persistence disabled. Repository settings are excluded.
- Codex runs in a temporary directory, outside the reviewed repository, with
  a read-only sandbox and no approvals. Hooks, plugins, apps and configured
  MCP servers are disabled. Configuration checks fail closed.
- Gemini's headless plan mode can switch to implementation, so its adapter is
  disabled until permanent restrictions are verified.
- These restrictions depend on the installed CLI and operating system. They
  are not a security boundary against every hostile repository. Agents can
  still read instructions in files; run untrusted code in a container that
  exposes only the repository and necessary authentication.
- Local Git configuration is trusted: configured clean filters can execute
  during diff collection. The wrapper does not sandbox Git itself.
- This tool makes no provider API calls and collects no telemetry. The agent
  CLIs send the diff and files they read to their providers. Their existing
  authentication decides billing: subscription login uses plan allowance,
  while API/provider credentials may incur charges. Check your CLI login first.
- Each reviewer makes one review call and at most one vote call. Timeouts
  terminate the subprocess group on macOS/Linux. Windows is not supported yet.

## Status

Preview, version 0.1.0. Adapters follow each tool's official headless
documentation and are tested against a scripted fake agent.

| Agent | Adapter tests | Live run |
| --- | --- | --- |
| Claude Code | Passed | 2.1.289: live review found a planted bug; a separate ballot confirmed it and rejected a false finding |
| Codex | Passed | 0.162.0-alpha.2: two reviews and two anonymous votes cross-confirmed one planted bug in 34s |
| Gemini CLI | Disabled safely | Not supported in this release |

Both live checks ran on October 8, 2026, using subscription logins. Fixture
files remained unchanged. The Codex run returned two differently worded entries
for the same bug; this is one detected defect, not two. These are synthetic
functionality checks, not an accuracy benchmark.

Live-run reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Related Incline projects

- [Coding Agent Guidelines](https://github.com/incline-ltd/coding-agent-guidelines): short rules for small, verified changes by coding agents.
- [Agent Cost Guard](https://github.com/incline-ltd/agent-cost-guard): a local hook that checks supported cloud-cost commands for approval.
- [Awesome Agentic Engineering](https://github.com/incline-ltd/awesome-agentic-engineering): a reviewed guide to coding-agent tools.

## License

[MIT](LICENSE)
