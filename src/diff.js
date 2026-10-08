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
  const { stdout } = await run("git", [
    "-c", "core.quotePath=false",
    "-c", "core.fsmonitor=false",
    "-c", "diff.suppressBlankEmpty=false",
    ...args,
  ], {
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
  const text = await git(root, [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv",
    "--src-prefix=a/", "--dst-prefix=b/", "-U3", from,
  ]);
  return { root, from, files: parseDiff(text) };
}

function unquote(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const escapes = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  const bytes = [];
  const inner = path.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length;
      } else {
        bytes.push(...Buffer.from(escapes[inner[++i]] ?? inner[i]));
      }
    } else {
      const character = String.fromCodePoint(inner.codePointAt(i));
      bytes.push(...Buffer.from(character));
      i += character.length - 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
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
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
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

    // Also accept diffs supplied directly with suppressed blank context markers.
    // Hunk counts keep a trailing newline from becoming an extra context line.
    const blankContext = line === "" && oldLine < hunk.oldStart + hunk.oldLines &&
      newLine < hunk.newStart + hunk.newLines;
    const type = blankContext ? " " : line[0];
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

/** Render new-file line numbers, or old-file line numbers for a deleted file. */
export function renderDiff(files) {
  const out = [];
  for (const file of files) {
    out.push(`### ${file.path} (${file.status})`);
    if (file.status === "renamed") out.push(`Renamed from: ${file.oldPath}`);
    if (file.status === "deleted") out.push("Line numbers refer to the deleted file before this change.");
    for (const hunk of file.hunks) {
      out.push(`@@ ${hunk.context}`.trimEnd());
      for (const l of hunk.lines) {
        const anchor = file.status === "deleted" ? l.oldLine : l.newLine;
        const number = anchor === undefined ? "" : String(anchor);
        out.push(`${l.type === " " ? " " : l.type} ${number.padStart(6)} | ${l.text}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export function normalizePath(path) {
  return String(path).replace(/^\.\//, "");
}

export function findDiffFile(files, path) {
  const normalized = normalizePath(path);
  return files.find((file) => file.path === normalized) ??
    files.find((file) => file.path === normalized.replace(/^[ab]\//, ""));
}

/** A finding is anchored when it cites a file in the diff and a line inside one of its hunks. */
export function isAnchored(files, path, line) {
  const file = findDiffFile(files, path);
  if (!file || !Number.isInteger(line) || line < 1) return false;
  return file.hunks.some((h) => h.lines.some((entry) =>
    (file.status === "deleted" ? entry.oldLine : entry.newLine) === line));
}
