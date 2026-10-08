import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export class AgentError extends Error {}

// Each adapter runs an installed agent CLI read-only and returns parsed JSON.
// Flags follow each tool's official non-interactive documentation.
export const AGENTS = {
  claude: { bin: "claude", env: "CODE_REVIEW_COUNCIL_CLAUDE", run: runClaude },
  codex: { bin: "codex", env: "CODE_REVIEW_COUNCIL_CODEX", run: runCodex },
  gemini: { bin: "gemini", env: "CODE_REVIEW_COUNCIL_GEMINI", run: runGemini },
};

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

export function exec(bin, args, { input = "", cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {}); // The agent may exit before reading all input.
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AgentError(`could not start ${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    });
    child.stdin.end(input);
  });
}

function tail(text, max = 400) {
  const trimmed = String(text).trim();
  return trimmed.length > max ? "..." + trimmed.slice(-max) : trimmed;
}

function check(result, timeoutMs) {
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
  throw new AgentError(`reply was not JSON: ${tail(raw, 200)}`);
}

async function runClaude({ bin, instruction, input, schema, cwd, timeoutMs, env }) {
  // Only read-only tools, user-level settings (so the reviewed repo's hooks and
  // permission rules do not load), and no MCP servers from the repo.
  const args = [
    "-p", instruction,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--permission-mode", "dontAsk",
    "--tools", "Read,Glob,Grep",
    "--setting-sources", "user",
    "--strict-mcp-config",
  ];
  const result = await exec(bin, args, { input, cwd, timeoutMs, env });
  check(result, timeoutMs);
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw new AgentError(`unexpected output (exit ${result.code}): ${tail(result.stderr || result.stdout)}`);
  }
  if (reply.is_error || result.code !== 0) {
    throw new AgentError(`failed (exit ${result.code}): ${tail(reply.result ?? result.stderr)}`);
  }
  return { data: reply.structured_output ?? extractJson(reply.result), ms: result.ms };
}

async function runCodex({ bin, instruction, input, schema, cwd, timeoutMs, env }) {
  const dir = await mkdtemp(join(tmpdir(), "code-review-council-"));
  try {
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "reply.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--ephemeral",
      "--output-schema", schemaPath,
      "-o", outPath,
      "-",
    ];
    const result = await exec(bin, args, { input: `${instruction}\n\n${input}`, cwd, timeoutMs, env });
    check(result, timeoutMs);
    if (result.code !== 0) throw new AgentError(`failed (exit ${result.code}): ${tail(result.stderr)}`);
    let reply;
    try {
      reply = await readFile(outPath, "utf8");
    } catch {
      throw new AgentError(`no final message written: ${tail(result.stderr)}`);
    }
    return { data: extractJson(reply), ms: result.ms };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runGemini({ bin, instruction, input, cwd, timeoutMs, env }) {
  // Plan mode keeps Gemini CLI read-only. It has no schema flag, so the reply is validated later.
  const args = ["-p", instruction, "--output-format", "json", "--approval-mode", "plan"];
  const result = await exec(bin, args, { input, cwd, timeoutMs, env });
  check(result, timeoutMs);
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw new AgentError(`unexpected output (exit ${result.code}): ${tail(result.stderr || result.stdout)}`);
  }
  if (reply.error || result.code !== 0) {
    throw new AgentError(`failed (exit ${result.code}): ${tail(reply.error?.message ?? result.stderr)}`);
  }
  return { data: extractJson(reply.response), ms: result.ms };
}

/** Run one agent once. Throws AgentError with a short reason on any failure. */
export async function runAgent(name, options) {
  const agent = AGENTS[name];
  const bin = resolveAgent(name, options.env);
  if (!agent || !bin) throw new AgentError(`${name} is not installed`);
  return agent.run({ ...options, bin });
}
