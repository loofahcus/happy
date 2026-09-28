---
name: rebasing-fork-onto-upstream
description: Use when rebasing feat/local-features (or any local fork branch) onto a newer upstream/main in this repo — classifying which local commits are superseded, which need re-authoring against upstream's restructured code, and updating BUG_FIX.md/NEW_FEATURES.md.
---

# Rebasing the Fork onto Upstream

## Overview

This repo (`slopus/happy`, forked as `loofahcus/happy`) tracks a local fork branch
(`feat/local-features`) that reimplements features/fixes on top of `upstream/main`.
Upstream moves fast and sometimes lands its own version of something the fork already
has. A straight `git rebase` is not enough — each fork commit needs to be *classified*
against what landed upstream, not just replayed.

## When to Use

- Upstream/main has moved and `feat/local-features` needs to catch up.
- You're resolving rebase conflicts and unsure whether a commit is still needed.
- `BUG_FIX.md` / `NEW_FEATURES.md` need updating after a rebase.

Not for: routine feature work on the fork that doesn't touch upstream sync.

## Workflow

1. **Back up first.** Before touching `feat/local-features`, create
   `backup/feat-local-features-pre-upstream-<short-sha-of-old-upstream-tip>`.
   Never rewrite `feat/local-features` in place until the rebase is verified.

2. **Work on a scratch branch.** Branch `rebase/upstream-<YYYYMMDD>` from the current
   `feat/local-features` tip, then rebase it onto `upstream/main`
   (`git rebase --onto upstream/main <old-base> rebase/upstream-<date>`, or interactive
   rebase if commit-by-commit judgment calls are needed). Only fast-forward
   `feat/local-features` to this branch once verification (step 5) passes.

3. **Classify every commit that conflicts or touches an area upstream also touched:**

   | Classification | Signal | Action |
   |---|---|---|
   | **Dropped** | Upstream shipped an equivalent/better version of the same fix or feature | Drop the fork commit; note which upstream commit/PR supersedes it |
   | **Re-authored** | Fork's diff doesn't apply cleanly because upstream restructured the touched code, but the fork's unique behavior isn't upstream yet | Reimplement the fork's unique delta against upstream's new code shape; do not fight the merge tool into a broken hybrid |
   | **Kept as-is** | Applies cleanly, no upstream overlap | Carry forward unchanged |

   Record the mapping (dropped commit → superseding upstream commit; re-authored
   commit → what was subsumed vs. what was newly written) — this is what makes the
   rebase auditable later and is worth a project memory note.

4. **Update the cumulative docs.** `BUG_FIX.md` and `NEW_FEATURES.md` are cumulative,
   one numbered section per fork commit, in history order — never overwritten, only
   appended/renumbered. Each section: Problem, Root Cause (bug fix) or Design
   (feature), a Files-changed table, and — only for re-authored commits — a
   "Notes / deviations from upstream commit `<hash>`" line explaining why the fork's
   original diff didn't apply and what changed.

   If a bug found during verification (step 5) gets its own doc section, and the user
   wants doc-per-commit atomicity too (not just code — see the note in step 5 on
   fixing at the origin commit), inserting that section at an earlier commit means
   renumbering every later section in that file. Before touching anything,
   `grep -n "section [0-9]"` the whole file and classify each hit: does it reference
   *this* file's numbering (needs updating if the target moved) or the *other* file's
   (leave alone — cross-file references keep their number since only one file's
   sequence is being renumbered). Do this scan once, up front — it turns a large diff
   into a handful of one-line fixes instead of discovering broken references file by
   file.

5. **Verify before fast-forwarding `feat/local-features`:**
   - Typecheck each touched package individually, not just the whole repo — compare
     against upstream/main's own baseline error count first, since upstream may carry
     pre-existing errors (e.g. native-module typings absent on Linux) unrelated to the
     rebase. Only new errors introduced by the rebase count.
   - Run each affected package's **full** test suite (`vitest run` with no path
     filter), not just targeted tests for files a conflict touched. Files that merge
     with zero conflicts can still break: a fork addition landing in a shared file
     (e.g. a new call inside a method a test extracts/mocks in isolation) can leave
     an existing, untouched-by-conflict test with a dangling `ReferenceError`, or two
     features that never coexisted before the rebase can interact badly on the same
     code path the first time they're both present. Neither shows up unless the whole
     suite runs.
   - Only after both pass, fast-forward/reset `feat/local-features` to the verified
     scratch branch.
   - When step 5's checks find a bug, fix it at its origin commit — `git rebase -i`,
     `edit` on the commit that introduced it, `git apply`/edit + `git commit --amend`
     — not by bolting a new fix commit onto the tip. The scratch branch hasn't been
     fast-forwarded yet, so this is the cheap moment to keep every commit independently
     buildable; bolting fixes on afterwards leaves commits in the middle of history
     that don't compile or pass tests on their own (verified by checking out a sample
     of them individually and running `pnpm typecheck`).
   - `git commit --amend` is only safe at an `edit` stop, where rebase has already
     created the commit and paused for you. At a conflicted `pick` (rebase stopped
     mid-cherry-pick, no commit made yet), the correct recovery is `git add <resolved
     files>` then `git rebase --continue` — never `--amend`. Amending there amends
     whatever HEAD currently is (the *previous* commit), silently folding the pending
     pick into it and erasing that commit's identity — `rebase --continue` then finds
     nothing left to commit and moves on. The final tree can still look byte-identical
     to correct, so this only shows up if you diff the resulting commit *subject list*
     against the last known-good list — do that after any rebase with several conflict
     stops, not just a tree diff.

6. **Every fork commit must stand alone.** After step 5's suite-level checks pass, do a
   second, commit-by-commit pass: for each fork commit (or a representative sample on a
   large rebase), `git checkout <sha>` into a scratch worktree and typecheck the touched
   package individually. This catches a different failure mode than step 5 — a commit
   that only compiles because a *later* commit in the same rebase happens to fix
   something it broke. If any commit fails standalone, that's the next check (7), not a
   new commit to bolt onto the tip.

7. **Classify "later commit fixes an earlier one" before squashing.** Scan the rebase's
   own commit range (not upstream) for commits whose diff is actually fixing a bug that
   an earlier *fork* commit introduced — grep commit messages for "fix"/"regression" and
   check whether the file/behavior traces back to a specific earlier commit in this same
   range via `git log -p --follow` or `git blame` on the buggy lines. Three outcomes:
   - **Fully self-inflicted**: the whole commit only exists to fix an earlier fork
     commit's bug. Squash it directly into that origin commit (`git rebase -i`, `edit`
     on the origin commit, cherry-pick/apply the fix's diff, `--amend`, then `drop` the
     now-empty fix commit).
   - **Composite/mixed**: part of the commit fixes an earlier fork commit's bug, part
     fixes something unrelated (pre-existing upstream code, or a bug not traceable to
     any commit in this range). Split it first — `git reset HEAD^` (unstages the diff,
     working tree keeps all changes), then stage and commit the two halves separately
     with `git add <files-or-hunks>` (use `git add -p` for same-file splits) +
     `git commit -F -` fed the *original* message via `git log --format=%B -1 <sha>` for
     the half that keeps it, and a new message for the half that doesn't. Only then
     squash the self-inflicted half into its origin commit as above.
   - **Unrelated**: fixes a real bug, but not one any commit in this range introduced.
     Leave it standalone — do not force a squash target that doesn't exist.
   This is manual, conflict-heavy work on anything but a trivial rebase — budget for
   multiple `git rebase --continue` conflict stops per split/squash.

8. **No pure-documentation commits.** If step 4's doc updates ever end up bundled into
   their own commit (e.g. from batching edits during conflict resolution), that violates
   doc-per-commit atomicity: every `BUG_FIX.md`/`NEW_FEATURES.md` section must live in
   the same commit as the code it documents, not a trailing docs-only commit. Redistribute
   each section back into its originating code commit (`edit` on that commit, append the
   section, `--amend`), then `drop` the now-empty docs commit. Renumbering follows the
   same up-front `grep -n "section [0-9]"` scan as step 4.

9. **Summarize what upstream brought in.** After verification passes, list the new
   upstream commits pulled in by this rebase (`git log --oneline <old-base>..upstream/main`)
   and summarize them for the user as two short lists — **New features** and
   **Bug fixes** — one line each, in plain language (not raw commit messages). Skip
   pure chores/releases/docs-only commits. This is about *upstream's* changes riding
   along with the rebase, not the fork's own `BUG_FIX.md`/`NEW_FEATURES.md` entries
   from step 4.

## Common Mistakes

- Rebasing mechanically and keeping a fork commit that upstream already superseded —
  causes silent duplicate/conflicting logic later.
- Force-merging a fork commit whose diff doesn't apply instead of re-authoring it
  against upstream's new code shape — produces a broken hybrid.
- Treating repo-wide typecheck/test failures as caused by the rebase without first
  checking whether they already exist on `upstream/main` itself.
- Moving `feat/local-features` (or other branches built on it) before verification
  passes, or before backups exist.
- Running only the tests for files a conflict touched, then declaring the rebase
  verified. A file that merged cleanly can still be broken by a fork addition
  elsewhere in the same module, or by two independently-fine features interacting for
  the first time now that the rebase puts them in the same file.
- Skipping the final summary or pasting the raw upstream commit log — the user wants
  to know what changed in their own app, not a dump of `git log`.
- Fixing a bug found during verification by adding a new commit at the tip instead of
  amending the commit that introduced it. Cheap in the moment, but leaves commits in
  the middle of history that don't build or pass tests standalone — a problem if
  anyone ever `git bisect`s or checks out one individually. Squash back with
  `git rebase -i` (`edit` + `git apply` + `--amend`, or `fixup`/`drop` for commits that
  become redundant) before considering the rebase done.
- Declaring commits "self-contained" from suite-level test/typecheck results alone.
  Full-suite checks (step 5) can pass even when an individual commit only compiles
  because a later commit in the rebase happens to fix what it broke — verify each
  commit standalone too (step 6).
- Squashing an entire mixed commit into its origin (or leaving it standalone) without
  first checking whether it's composite — a commit that fixes both a self-inflicted
  fork bug *and* an unrelated pre-existing one needs to be split (step 7) before either
  half is squashed or kept.
- Letting doc updates from step 4 collect into their own trailing commit during
  conflict resolution. Every doc section belongs in the same commit as the code it
  documents — a pure-docs commit needs its sections redistributed back (step 8), not
  left as-is just because it's convenient mid-rebase.
