# Example report

This is real output from `code-review-council` run on a small change to
`cart.js`. The two reviewers are the scripted test agents in
`tests/fixtures/`, not Claude or Codex, so the findings are illustrative.
It shows the report format and how confirmation works:

- the loop bug was reported by both reviewers independently;
- the discount finding was reported by one reviewer and confirmed by the other in the anonymous vote;
- the rename suggestion was rejected in the vote, so it stays unconfirmed;
- one finding cited a line outside the change and was dropped.

The diff under review:

```diff
@@ -1,5 +1,5 @@
 export function total(items, discount) {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) sum += items[i].price;
-  return sum;
+  for (let i = 0; i <= items.length; i++) sum += items[i].price * items[i].qty;
+  return sum - (sum * discount) / 100;
 }
```

---

## Code review council: 2 confirmed findings

Reviewers: claude, codex. Diff: 1 file, +2 -2. Time: 0s. A finding needs 2 reviewers to agree.

| # | Severity | Location | Finding |
| --- | --- | --- | --- |
| 1 | high | `cart.js:3` | Loop reads one item past the end |
| 2 | medium | `cart.js:4` | Discount is not bounded |

### 1. Loop reads one item past the end

`cart.js:3`, high. Found independently by claude, codex.

`i <= items.length` makes the last pass read `items[items.length]`, which is undefined, so `.price` throws a TypeError for every non-empty cart.

### 2. Discount is not bounded

`cart.js:4`, medium. Found by claude; confirmed by codex.

A discount above 100 or below 0 produces a negative total or a surcharge. Nothing in the change validates it.

<details><summary>1 unconfirmed (reported by one reviewer, not confirmed)</summary>

- `cart.js:1` low: Rename total to computeTotal (found by codex; rejected by claude)

</details>

1 finding was dropped for citing a line outside the diff.
