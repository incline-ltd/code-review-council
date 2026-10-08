# Security policy

## Supported version

The latest 0.1.x preview and the latest commit on `main` receive fixes.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/incline-ltd/code-review-council/security/advisories/new)
to report a security problem. Do not include exploit details or private code
in a public issue.

Useful reports include:

- a way for reviewed code to make an agent write files or run state-changing
  commands through this tool;
- an adapter flag that weakens an agent's read-only mode;
- review content or prompts being sent anywhere other than the agent CLIs the
  user chose;
- a crash or hang caused by a crafted diff.

## Known limits

The diff is marked as untrusted in every prompt, but prompt injection cannot
be fully prevented. Claude uses read-only tools with hooks and MCP disabled.
Codex uses a read-only sandbox from an isolated working directory, with
external tools and executable customizations disabled. Gemini is disabled
because headless plan mode alone does not prevent implementation.

These controls depend on the installed CLI and host. They do not establish
complete isolation from private files or provider-side behavior. Agents can
still read repository instructions as context. Review untrusted code in a
container with only the required files and authentication available.

The local Git configuration is also trusted. Git clean filters can execute
while collecting a working-tree diff. The wrapper disables external diff
commands, text conversion and fsmonitor, but it does not sandbox Git itself.
