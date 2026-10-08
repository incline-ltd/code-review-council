import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export class AgentError extends Error {}

// Each adapter runs an installed agent CLI read-only and returns parsed JSON.
// Flags follow each tool's official non-interactive documentation.
export const AGENTS = {
  claude: { bin: "claude", env: "CODE_REVIEW_COUNCIL_CLAUDE", run: runClaude },
  codex: { bin: "codex", env: "CODE_REVIEW_COUNCIL_CODEX", run: runCodex },
  gemini: {
    bin: "gemini", env: "CODE_REVIEW_COUNCIL_GEMINI",
    unsupported: "Gemini CLI is not supported in 0.1.0: headless plan mode can enable writes. Use Claude Code or Codex.",
  },
};

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1000;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(bin, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH || "").split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (dir && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Path of the agent's CLI: an explicit override from the environment, else PATH. */
export function resolveAgent(name, env = process.env) {
  const agent = AGENTS[name];
  if (!agent) return null;
  return env[agent.env] || findOnPath(agent.bin, env);
}

export function exec(bin, args, { input = "", cwd, timeoutMs, env = process.env, maxOutputBytes = MAX_OUTPUT_BYTES, signal: abortSignal }) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) { reject(new AgentError("interrupted")); return; }
    const started = Date.now();
    const grouped = process.platform !== "win32";
    const child = spawn(bin, args, { cwd, env, detached: grouped, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputExceeded = false;
    let interrupted = false;
    let stopped = false;
    let settled = false;
    let outputBytes = 0;
    let killTimer;
    const signal = (name) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(name);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      abortSignal?.removeEventListener("abort", onInterrupt);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      // Also stop helpers which closed their pipes but outlived the agent.
      signal("SIGKILL");
      cleanup();
      resolve({ code, stdout, stderr, timedOut, outputExceeded, interrupted, ms: Date.now() - started });
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        signal("SIGKILL");
        // A detached descendant can retain pipes; never wait indefinitely for close.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, KILL_GRACE_MS);
    };
    const onInterrupt = () => { interrupted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    abortSignal?.addEventListener("abort", onInterrupt, { once: true });
    const capture = (stream) => (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) { outputExceeded = true; stop(); return; }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", capture("stdout"));
    child.stderr.setEncoding("utf8").on("data", capture("stderr"));
    child.stdin.on("error", () => {}); // The agent may exit before reading all input.
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AgentError(`could not start agent process (${error.code || "unknown error"}); check the configured executable`));
    });
    child.on("close", finish);
    child.stdin.end(input);
  });
}

function check(result, timeoutMs) {
  if (result.interrupted) throw new AgentError("interrupted");
  if (result.outputExceeded) throw new AgentError("agent output exceeded the 4 MiB limit");
  if (result.timedOut) throw new AgentError(`timed out after ${Math.round(timeoutMs / 1000)}s`);
}

/** Parse JSON from a model reply, tolerating code fences or text around the object. */
export function extractJson(text) {
  if (text && typeof text === "object") return text;
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {}
    }
  }
  throw new AgentError("reply was not valid JSON; check the agent CLI version and structured-output support");
}

async function runClaude({ bin, instruction, input, schema, cwd, timeoutMs, remainingMs, env, signal }) {
  // Preserve normal login while disabling hooks and executable customizations.
  // https://code.claude.com/docs/en/cli-reference
  // https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder
  const args = [
    "-p", instruction,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--permission-mode", "dontAsk",
    "--tools", "Read,Glob,Grep",
    "--safe-mode",
    "--setting-sources", "user",
    "--settings", '{"disableAllHooks":true}',
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--no-session-persistence",
  ];
  const result = await exec(bin, args, { input, cwd, timeoutMs: remainingMs(), env, signal });
  check(result, timeoutMs);
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw new AgentError(`unexpected output (exit ${result.code}); check Claude Code sign-in and structured-output support`);
  }
  if (reply.is_error || result.code !== 0) {
    throw new AgentError(`Claude Code failed (exit ${result.code}); check its sign-in and provider access`);
  }
  return { data: reply.structured_output ?? extractJson(reply.result), ms: result.ms };
}

const CODEX_CONFIG = [
  "--disable", "hooks", "--disable", "plugins", "--disable", "apps",
  "-c", 'approval_policy="never"',
  "-c", 'web_search="disabled"',
  "-c", "allow_login_shell=false",
  "-c", "notify=[]",
];

async function codexMcpIsolation(bin, options) {
  const list = async (overrides) => {
    const result = await exec(bin, ["mcp", "list", "--json", ...CODEX_CONFIG, ...overrides], {
      ...options, timeoutMs: options.remainingMs(),
    });
    check(result, options.timeoutMs);
    if (result.code !== 0) throw new AgentError("could not inspect Codex MCP configuration; no review started");
    let servers;
    try { servers = JSON.parse(result.stdout); } catch {}
    if (!Array.isArray(servers) || servers.some((s) => !s || typeof s.name !== "string" || typeof s.enabled !== "boolean")) {
      throw new AgentError("unexpected Codex MCP configuration; no review started");
    }
    return servers;
  };
  // Empty TOML tables merge, so mcp_servers={} does not disable existing servers.
  // List is configuration-only; it does not start servers or invoke a model.
  const servers = await list([]);
  const overrides = ["-c", `mcp_servers={${servers.map(({ name }) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`];
  if ((await list(overrides)).some((server) => server.enabled)) {
    throw new AgentError("Codex MCP servers could not be disabled; no review started");
  }
  return overrides;
}

async function runCodex({ bin, instruction, input, schema, cwd, timeoutMs, remainingMs, env, signal }) {
  const dir = await mkdtemp(join(tmpdir(), "code-review-council-"));
  try {
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "reply.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    // Start outside the reviewed repository so none of its .codex config loads.
    // Keep the user's login/model/provider preferences, then deny external tools.
    // https://learn.chatgpt.com/docs/cli/reference
    // https://learn.chatgpt.com/docs/config-file/config-basic
    // https://learn.chatgpt.com/docs/hooks
    const mcp = await codexMcpIsolation(bin, { cwd: dir, timeoutMs, remainingMs, env, signal });
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ignore-rules",
      ...CODEX_CONFIG, ...mcp,
      "--ephemeral",
      "--output-schema", schemaPath,
      "-o", outPath,
      "-",
    ];
    const context = `Repository root: ${JSON.stringify(resolve(cwd))}. Read source files there, using absolute paths. Report paths relative to that repository. Do not change directories or load its agent configuration.\n\n`;
    const result = await exec(bin, args, { input: `${instruction}\n\n${context}${input}`, cwd: dir, timeoutMs: remainingMs(), env, signal });
    check(result, timeoutMs);
    if (result.code !== 0) throw new AgentError(`Codex failed (exit ${result.code}); check its sign-in, provider access, and required CLI flags`);
    let reply;
    try {
      if (statSync(outPath).size > MAX_OUTPUT_BYTES) throw new AgentError("agent reply exceeded the 4 MiB limit");
      reply = await readFile(outPath, "utf8");
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("Codex wrote no final message; check its structured-output support");
    }
    return { data: extractJson(reply), ms: result.ms };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run one agent once. Throws AgentError with a short reason on any failure. */
export async function runAgent(name, options) {
  if (options.signal?.aborted) throw new AgentError("interrupted");
  if (process.platform === "win32") throw new AgentError("native Windows is not supported in 0.1.0; use WSL, Linux, or macOS");
  const agent = AGENTS[name];
  if (agent?.unsupported) throw new AgentError(agent.unsupported);
  const bin = resolveAgent(name, options.env);
  if (!agent || !bin) throw new AgentError(`${name} is not installed`);
  const started = Date.now();
  const remainingMs = () => {
    if (options.signal?.aborted) throw new AgentError("interrupted");
    const remaining = options.timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new AgentError(`timed out after ${Math.round(options.timeoutMs / 1000)}s`);
    return remaining;
  };
  const result = await agent.run({ ...options, bin, remainingMs });
  if (options.signal?.aborted) throw new AgentError("interrupted");
  return { ...result, ms: Date.now() - started };
}
