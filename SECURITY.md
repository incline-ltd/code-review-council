# Security policy

## Supported version

Until the first release, only the latest commit on `main` is supported.

## Report a vulnerability

Use GitHub private vulnerability reporting when it is available for this
repository. Do not open a public issue for a security problem.

Useful reports include:

- a way for reviewed code to make an agent write files or run state-changing
  commands through this tool;
- an adapter flag that weakens an agent's read-only mode;
- review content or prompts being sent anywhere other than the agent CLIs the
  user chose;
- a crash or hang caused by a crafted diff.

## Known limits

The diff is marked as untrusted in every prompt, but prompt injection from the
code under review cannot be fully prevented. Claude Code is started with only
read-only tools, user-level settings, and no repository MCP servers, so the
reviewed repository's project hooks do not run. Codex and Gemini CLI follow
their own project-trust rules. Agents still read repository instruction files
as context. For untrusted code, run the tool in a container.
