import assert from "node:assert/strict";
import { test } from "node:test";
import { diffStats, isAnchored, parseDiff, renderDiff } from "../src/diff.js";

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
`.replace("\\t", "\t");

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
  assert.ok(isAnchored(files, "old.txt", 0), "a pure deletion anchors at its hunk position");
  assert.ok(!isAnchored(files, "src/app.js", 2.5));
});

test("renders new-file line numbers for reviewers", () => {
  const text = renderDiff(parseDiff(DIFF));
  assert.match(text, /^### src\/app.js \(modified\)$/m);
  assert.match(text, /^\+      2 \| const limit = 100;$/m);
  assert.match(text, /^-        \| const limit = 10;$/m);
  assert.match(text, /^### a.js -> b.js \(renamed\)$/m);
});
