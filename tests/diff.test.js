import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDiff, diffStats, isAnchored, parseDiff, renderDiff } from "../src/diff.js";

const DIFF = `diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,4 +1,5 @@
 import x from "x";
-const limit = 10;
+const limit = 100;
+const retries = 3;

 export default x;
@@ -20,3 +21,3 @@ function run() {
   start();
-  stop();
+  stop(true);
 }
diff --git a/docs/new file.md b/docs/new file.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new file.md\t
@@ -0,0 +1,2 @@
+# Title
+Body
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/a.js b/b.js
similarity index 90%
rename from a.js
rename to b.js
index 5555555..6666666 100644
--- a/a.js
+++ b/b.js
@@ -3 +3 @@
-old
+new
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/package-lock.json b/package-lock.json
index 9999999..aaaaaaa 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"x":1}
`.replace("\\t", "\t").replace("\n\n export", "\n \n export");

test("parses files, statuses, and line numbers", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ["src/app.js", "modified"],
      ["docs/new file.md", "added"],
      ["old.txt", "deleted"],
      ["b.js", "renamed"],
    ],
  );
  const app = files[0];
  assert.equal(app.hunks.length, 2);
  assert.equal(app.additions, 3);
  assert.equal(app.deletions, 2);
  const added = app.hunks[0].lines.filter((l) => l.type === "+").map((l) => l.newLine);
  assert.deepEqual(added, [2, 3]);
  assert.equal(app.hunks[1].lines.find((l) => l.type === "+").newLine, 22);
  assert.equal(files[3].oldPath, "a.js");
  assert.deepEqual(diffStats(files), { files: 4, additions: 6, deletions: 5 });
});

test("skips binary files and lockfiles", () => {
  const paths = parseDiff(DIFF).map((f) => f.path);
  assert.ok(!paths.includes("logo.png"));
  assert.ok(!paths.includes("package-lock.json"));
});

test("anchors only lines inside a hunk of a changed file", () => {
  const files = parseDiff(DIFF);
  assert.ok(isAnchored(files, "src/app.js", 3));
  assert.ok(isAnchored(files, "./src/app.js", 22));
  assert.ok(isAnchored(files, "b/src/app.js", 5));
  assert.ok(!isAnchored(files, "src/app.js", 12));
  assert.ok(!isAnchored(files, "src/other.js", 3));
  assert.ok(isAnchored(files, "old.txt", 1), "a deleted file anchors at its original line");
  assert.ok(!isAnchored(files, "old.txt", 0));
  assert.ok(!isAnchored(files, "src/app.js", 2.5));
});

test("renders new-file line numbers for reviewers", () => {
  const text = renderDiff(parseDiff(DIFF));
  assert.match(text, /^### src\/app.js \(modified\)$/m);
  assert.match(text, /^\+      2 \| const limit = 100;$/m);
  assert.match(text, /^-        \| const limit = 10;$/m);
  assert.match(text, /^### b.js \(renamed\)$/m);
  assert.match(text, /^Renamed from: a.js$/m);
  assert.match(text, /^-      1 \| one$/m);
});

test("a real directory named a or b is not stripped from finding paths", () => {
  const files = parseDiff(`diff --git a/a/file.js b/a/file.js
--- a/a/file.js
+++ b/a/file.js
@@ -1 +1 @@
-old
+new
`);
  assert.ok(isAnchored(files, "a/file.js", 1));
  assert.ok(isAnchored(files, "b/a/file.js", 1));
  assert.ok(!isAnchored(files, "file.js", 1));
});

test("parses quoted Git filenames and rename-only paths with spaces", () => {
  const files = parseDiff(String.raw`diff --git "a/tab\tfile.js" "b/tab\tfile.js"
--- "a/tab\tfile.js"
+++ "b/tab\tfile.js"
@@ -1 +1 @@
-old
+new
diff --git "a/caf\303\251.js" "b/caf\303\251.js"
--- "a/caf\303\251.js"
+++ "b/caf\303\251.js"
@@ -1 +1 @@
-old
+new
diff --git a/old name.js b/new name.js
similarity index 100%
rename from old name.js
rename to new name.js
`);
  assert.deepEqual(files.map((file) => file.path), ["tab\tfile.js", "café.js", "new name.js"]);
  assert.equal(files[2].oldPath, "old name.js");
  assert.ok(isAnchored(files, "tab\tfile.js", 1));
});

test("collecting a diff does not run configured text conversion commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crc-textconv-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, ".gitattributes"), "*.js diff=review\n");
  writeFileSync(join(dir, "code.js"), "before\n");
  writeFileSync(join(dir, "marker"), "unchanged");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("config", "diff.review.textconv", "sh -c 'printf changed > marker; cat \"$0\"'");
  writeFileSync(join(dir, "code.js"), "after\n");
  const result = await collectDiff({ cwd: dir });
  assert.equal(readFileSync(join(dir, "marker"), "utf8"), "unchanged");
  assert.equal(result.files[0].path, "code.js");
  assert.equal(result.files[0].additions, 1);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crc-diff-settings-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "app.js"), "one\n\nthree\nold\nfive\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  writeFileSync(join(dir, "app.js"), "one\n\nthree\nnew\nfive\n");
  return { dir, git };
}

test("Git display settings cannot change parsed file paths or line numbers", async () => {
  const settings = [
    { "diff.mnemonicPrefix": "true" },
    { "diff.srcPrefix": "before/", "diff.dstPrefix": "after/" },
    { "diff.noprefix": "true" },
    { "diff.suppressBlankEmpty": "true" },
    { "diff.mnemonicPrefix": "true", "diff.srcPrefix": "before/", "diff.dstPrefix": "after/", "diff.suppressBlankEmpty": "true" },
  ];
  for (const configuration of settings) {
    const { dir, git } = fixture();
    for (const [name, value] of Object.entries(configuration)) git("config", name, value);
    const { files } = await collectDiff({ cwd: dir });
    assert.equal(files[0].path, "app.js", JSON.stringify(configuration));
    assert.equal(files[0].hunks[0].lines.find((line) => line.type === "+").newLine, 4);
    assert.ok(isAnchored(files, "app.js", 4));
    assert.match(renderDiff(files), /^\+      4 \| new$/m);
  }
});

test("suppressed blank context stays in the hunk but the trailing newline does not", () => {
  const files = parseDiff(`diff --git a/app.js b/app.js
--- a/app.js
+++ b/app.js
@@ -1,5 +1,5 @@
 one

 three
-old
+new
 five
`);
  const lines = files[0].hunks[0].lines;
  assert.equal(lines.find((line) => line.type === "+").newLine, 4);
  assert.equal(lines.filter((line) => line.newLine !== undefined).length, 5);
  assert.equal(lines.at(-1).newLine, 5);
});

test("collecting a diff does not invoke a configured fsmonitor hook", async () => {
  const { dir, git } = fixture();
  const marker = join(dir, "marker");
  const hook = join(dir, ".git", "hooks", "review-fsmonitor");
  writeFileSync(marker, "unchanged");
  writeFileSync(hook,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "changed");\nprocess.stdout.write("token\\0");\n`,
    { mode: 0o700 });
  git("config", "core.fsmonitor", hook);
  git("diff", "HEAD");
  assert.equal(readFileSync(marker, "utf8"), "changed", "the fixture hook runs without the override");
  writeFileSync(marker, "unchanged");
  const { files } = await collectDiff({ cwd: dir });
  assert.equal(readFileSync(marker, "utf8"), "unchanged");
  assert.equal(files[0].path, "app.js");
  assert.equal(files[0].additions, 1);
});
