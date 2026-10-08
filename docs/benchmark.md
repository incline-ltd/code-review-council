# Benchmark plan

Status: **not run yet.** No accuracy claim is made until it is.

## Question

On real pull requests, does a council of agents report fewer false findings
than one agent, and how much recall does it give up?

## Dataset

[AACR-Bench](https://github.com/alibaba/aacr-bench) from Alibaba
([paper](https://arxiv.org/abs/2601.19494),
[data](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench), Apache-2.0):
200 pull requests from 50 open-source projects in 10 languages, with 1,505
expert-verified review comments. It is the benchmark that
[open-code-review](https://github.com/alibaba/open-code-review) reports
against, so results are directly comparable.

## Method

Use the official AACR-Bench evaluation pipeline, which already runs Claude
Code and Codex as reviewers. Add a `code-review-council` reviewer next to them
and change nothing else: same data, same matching, same judge.

| Arm | Reviewers |
| --- | --- |
| A | Claude Code alone |
| B | Codex alone |
| C | Council: Claude Code + Codex |
| D | Council: Claude Code + Codex + Gemini CLI |

open-code-review is compared through a rerun with the same model where
possible, otherwise through its published numbers, labeled as such.

## Metrics

From AACR-Bench: positive precision, positive recall, line-level precision and
recall, and noise rate. Added by this project: wall time and agent calls per
pull request.

## Rules

- Pin the dataset version, every CLI version, and every model before the run.
- Run a small pilot first. Fix only harness bugs, never prompts tuned to the
  test set, before the full run.
- Publish the raw reviewer outputs and the metric files.
- Publish the result whatever it shows, including if the council is worse.

## Cost

Reviews run through each agent CLI's existing login, so they count against
those plans' usage limits. The pipeline's semantic judge calls a model API,
which is billed separately. Line-level metrics can be computed first without
the judge.
