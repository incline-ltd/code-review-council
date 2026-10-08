# Contributing

Requires Node.js 20 or newer and Git. There is nothing to install.

```bash
git clone https://github.com/incline-ltd/code-review-council.git
cd code-review-council
npm test
```

Good contributions:

- A live-run report for an agent CLI version, with the exact command and what
  happened. Remove anything private first.
- An adapter fix backed by the tool's official documentation.
- A failing test for a diff the parser gets wrong.
- Benchmark results produced with the method in [docs/benchmark.md](docs/benchmark.md).

Keep pull requests focused, add a test for behavior changes, and keep agents
read-only.

Links in contributions must support the change: official documentation, source,
reproducible evidence or a useful integration example. Disclose affiliation
when submitting your own project. Unrelated personal links, referral links,
paid placement and promotional additions are not accepted.
