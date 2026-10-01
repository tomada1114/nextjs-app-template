# PR, CI and merge (steps 5–7)

The detail behind [SKILL.md steps 5–7](../SKILL.md#5-open-the-pr): from a reviewed,
pushed branch to a merged PR, a closed issue, and a checkout back on the default branch.
This stretch is serial in both modes: one PR at a time, in the batch's
dependency-then-priority order — finish an issue's PR → CI → merge before opening the
next.

## Table of Contents

- [Opening the PR](#opening-the-pr)
- [Watching CI](#watching-ci)
- [Waiting inside the command timeout](#waiting-inside-the-command-timeout)
- [Merging](#merging)
- [After the merge](#after-the-merge)

## Opening the PR

Commits but nothing pushed → push from this session
(`git -C <workdir> push -u origin <branch>`). No commits at all → no branch: record
`--event blocked --field issue=<n>`, report `SKIPPED(<why>)`, and in `all` mode move on.

Open a PR from `<branch>` against `<default_branch>`, titled `<PR-TITLE>`. The body must
carry **`Closes #N`** after the summary (a bare `#N` closes nothing) and target the
**default branch** (auto-close only fires there) — build it from `PR-SUMMARY`,
`Closes #N`, `TEST-PLAN`. Record
(`--event pr-created --field issue=<n> --field pr=<url>`), then:

```bash
.agents/skills/shipping-issues/scripts/link_check.sh <pr> --issue <n> --fix
```

Run it before step 6's watch starts: every body edit it makes fires the PR's `edited`
event, which re-runs the PR-title and labeling workflows, and a run cancelled by the
next edit must not land inside a watch. `land_pr.sh` re-checks the link at merge time
without `--fix`; this earlier call is not redundant, because it is the only one that
repairs, and it catches `WRONG_BASE` before CI spends thirty minutes on the wrong base.
`WRONG_BASE` → retarget before merging. When GitHub lists no link to the issue, `--fix`
reads the body first and never adds a second keyword:

- **No closing keyword for `#N` in the body** → it appends `Closes #N`.
- **The keyword is there, or was just appended, and GitHub still lists no link** → it
  re-saves the body: a minimal body of only `Closes #N`, then the full body put back, at
  most 2 times (4 edits), a few seconds apart, stopping as soon as the link appears. The
  full body is restored after every minimal save, including on an interrupt; if it
  cannot be, the verdict is `ERROR` and the detail names the file holding the full body
  and the `gh pr edit` that puts it back (the PR description's edit history on GitHub
  keeps it too) — restore it before anything else. A body it could not read is never
  rewritten (`ERROR`).

`NOT_LINKED`'s `detail:` says which case is left. "has no Closes/Fixes/Resolves
keyword", or "closes #M but not the target issue #N", means the body still lacks the
keyword (its `fix:` line says the edit failed): re-run `--fix`, or add `Closes #N` to
the body by hand. "has a closing keyword for #N, but GitHub has not linked it" means the
re-saves left the link missing: go on to step 6 anyway. Step 7's `land_pr.sh` then
refuses the merge with `result: NOT_LINKED`, and the PR is held for the human
([landing-outcomes.md](landing-outcomes.md)): merging it with `--no-link-check` is their
decision, never this run's.

## Watching CI

Wait for the PR's new head commit to appear among the branch's CI runs before watching —
the checks API serves the previous commit's results for a minute or two after a push,
and a stale PASS is worse than a stale FAIL. Then:

```bash
.agents/skills/shipping-issues/scripts/ci_watch.sh <pr> --timeout <seconds> > <runstate>/ci/<pr>.log
grep -E '^(verdict|waited_seconds|head_sha|mergeable|merge_state|review_decision):' <runstate>/ci/<pr>.log
```

Redirected — raw output carries failing-run log tails that must stay out of this
context. Keep `failed_checks:` for repair. `ci_watch.sh` is the run's only wait
primitive: **never a hand-rolled sleep/poll loop**. One PR at a time, even in `all`
mode. Record (`--event ci ...`).

| `verdict:`           | Next                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`               | [Merge](#merging), in the same turn.                                                                                                      |
| `FAIL`               | [recovery.md#ci-fails](recovery.md#ci-fails) with [agent-ci-repair.md](agent-ci-repair.md), at most 3 attempts; re-watch after each push. |
| `TIMEOUT`            | Not a verdict on the code — [wait again](#waiting-inside-the-command-timeout), up to 1800 s in total; past that, treat it as `ERROR`.     |
| `NO_CHECKS`, `ERROR` | [recovery.md#no_checks-error-and-other-non-verdicts](recovery.md#no_checks-error-and-other-non-verdicts).                                 |

## Waiting inside the command timeout

CI can take up to 30 minutes to settle, and a host cuts a foreground command off well
before that. Pick the first of these the host supports:

1. **Foreground, in slices.** Run `ci_watch.sh <pr> --timeout <N>` with `N` safely below
   the command timeout this host applies to the call — raise the call's own timeout
   where the host lets it, and keep `N` under it. On `verdict: TIMEOUT`, add its
   `waited_seconds:` to a running total and run the same watch again; stop at 1800 s in
   total and treat the PR as `ERROR`. Each slice re-reads the PR from scratch, so
   nothing is lost between them.
2. **Background, with completion reported.** On a host that can run a command in the
   background and re-invoke the session when it exits, start
   `ci_watch.sh <pr> --timeout 1800 > <runstate>/ci/<pr>.log` that way and wait for that
   report. Until that verdict is read, nothing else on the shipping path moves — no next
   step 3, no other PR, no checkout or branch switch; the only work allowed meanwhile is
   draining [step 8b](../SKILL.md#8b-unblock-held-designs-in-the-background)'s
   background queue. A `TIMEOUT` after the full 1800 s is `ERROR`.

Never stand in for either with `sleep` or a poll loop of your own: the script's own
timeout and verdicts are what make a stalled CI a reported outcome rather than a hung
run.

## Merging

```bash
.agents/skills/shipping-issues/scripts/land_pr.sh <pr> --issue <n> --head-sha <head_sha>
```

`<head_sha>` is the `head_sha:` line of the `PASS` in `<runstate>/ci/<pr>.log` — the
commit CI verified. The merge is pinned to it (`gh pr merge --match-head-commit`), so a
push that landed after the watch makes GitHub refuse the merge instead of merging an
unverified commit (`MERGE_REFUSED`: watch CI again). When the log has no `head_sha:`
line, omit the flag: the script then pins to the head it reads just before it checks the
merge state.

Merge as soon as CI reports `verdict: PASS` — call `land_pr.sh` in that same turn. Do
not ask whether to merge, and do not report the green CI and wait: green CI is the
approval. Read `result:` and `issue:`. Every result, and the two that must never read as
success: [landing-outcomes.md](landing-outcomes.md). Record (`--event merged ...`).

## After the merge

```bash
git switch <default_branch> && git pull --ff-only
```

after every merge, and again as the run's last act — the run never ends parked on a
feature branch. In parallel mode the main checkout is already there; pull it anyway so
it carries the merge that just landed.

**Serial `all`:** re-plan (`plan.py --mode all --refresh --allow-existing-worktrees`)
and start the next issue's step 3 from this up-to-date branch, without pausing.
**Parallel `all`:** the batch's remaining branches are now behind; bring each up to date
in its own worktree **before its own PR** rather than after a CI failure, and merge
rather than rebase
([how](recovery.md#bringing-the-rest-of-a-parallel-batch-up-to-date)). A conflict either
way means the grouping call was wrong for that pair
([recovery.md#a-merge-conflict](recovery.md#a-merge-conflict)). Only when the whole
batch has merged does the run group the next batch.
