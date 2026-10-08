import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Generated files that reviewers should not spend effort on.
const SKIPPED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);

async function git(cwd, args) {
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Collect the diff to review: the working tree against HEAD, or against the merge base with `base`. */
export async function collectDiff({ cwd, base }) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  let from = "HEAD";
  if (base) {
    from = (await git(root, ["merge-base", base, "HEAD"])).trim();
  } else {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  }
  const text = await git(root, ["diff", "--no-color", "--no-ext-diff", "-U3", from]);
  return { root, from, files: parseDiff(text) };
}

function unquote(path) {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function stripPrefix(path) {
  return path.replace(/^[ab]\//, "");
}

/** Parse `git diff` output into files, hunks, and line numbers. */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/);
      file = {
        path: match ? stripPrefix(unquote(match[2])) : "",
        oldPath: match ? stripPrefix(unquote(match[1])) : "",
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) file.status = "renamed";
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("--- ") && line !== "--- /dev/null") {
        file.oldPath = stripPrefix(unquote(line.slice(4).replace(/\t$/, "")));
      } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        file.path = stripPrefix(unquote(line.slice(4).replace(/\t$/, "")));
      }
    }

    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        context: header[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;

    const type = line[0];
    if (type === "+") {
      hunk.lines.push({ type, text: line.slice(1), newLine: newLine++ });
      file.additions++;
    } else if (type === "-") {
      hunk.lines.push({ type, text: line.slice(1), oldLine: oldLine++ });
      file.deletions++;
    } else if (type === " ") {
      hunk.lines.push({ type, text: line.slice(1), newLine: newLine++, oldLine: oldLine++ });
    }
  }

  for (const f of files) if (!f.path) f.path = f.oldPath;
  return files.filter((f) => !f.binary && !SKIPPED_FILES.has(basename(f.path)));
}

export function diffStats(files) {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** Render the diff with new-file line numbers so reviewers can cite exact lines. */
export function renderDiff(files) {
  const out = [];
  for (const file of files) {
    const label = file.status === "renamed" ? `${file.oldPath} -> ${file.path}` : file.path;
    out.push(`### ${label} (${file.status})`);
    for (const hunk of file.hunks) {
      out.push(`@@ ${hunk.context}`.trimEnd());
      for (const l of hunk.lines) {
        const number = l.newLine === undefined ? "" : String(l.newLine);
        out.push(`${l.type === " " ? " " : l.type} ${number.padStart(6)} | ${l.text}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export function normalizePath(path) {
  return String(path).trim().replace(/^\.\//, "").replace(/^[ab]\//, "");
}

/** A finding is anchored when it cites a file in the diff and a line inside one of its hunks. */
export function isAnchored(files, path, line) {
  const file = files.find((f) => f.path === normalizePath(path));
  if (!file || !Number.isInteger(line)) return false;
  return file.hunks.some((h) => {
    const last = h.newStart + Math.max(h.newLines, 1) - 1;
    return line >= h.newStart && line <= last;
  });
}
