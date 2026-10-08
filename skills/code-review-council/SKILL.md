---
name: code-review-council
description: Review code changes with several installed coding-agent CLIs (Claude Code and Codex) and report only findings that a second reviewer confirms. Use when the user asks for a code review of uncommitted changes, a branch, or a pull request before merging.
---

# Code Review Council

1. Find the CLI. Run `code-review-council --version`. If it is not installed,
   use `node <checkout>/bin/code-review-council.js` from a clone of
   https://github.com/incline-ltd/code-review-council.
2. Pick the scope with the user:
   - uncommitted changes: no flag;
   - the whole branch: `--base <default branch>`, for example `--base main`.
3. Run it from the repository root with `--out <temp file>`. It calls every
   supported installed agent CLI and can take several minutes, so allow a long timeout
   or run it in the background.
4. Report the confirmed findings with `file:line`, severity, and the
   explanation. Mention how many findings were unconfirmed, but do not present
   unconfirmed findings as defects.
5. Exit code 2 means the review is incomplete. Report the failure instead of
   treating an empty result as a clean review.
6. Do not change code unless the user asks for fixes.

The tool runs each agent read-only. For code the user does not trust,
suggest running it in a container.
