---
name: shipping-issues
description: >-
  Rank open GitHub Issues by their `priority: P0`-`P3` labels, backfilling missing ones,
  then implement the top issue, review its branch, open a PR that closes it, watch CI to
  green, merge, and return to the default branch. Pass "all" to work through every issue
  in dependency order, independent ones in parallel git worktrees. Use when asked to
  ship the remaining issues, take on the next issue, or clear the ticket backlog.
---

# Shipping Issues

**Done means all three:** the PR is merged to the default branch, the issue is CLOSED,
and nothing was deleted or weakened to get there.

**Invoking this skill is the sign-off for exactly the remote writes it lists, for this
invocation, up to and including the merge** — priority and status labels, syncing label
definitions from `.github/labels.yml` with `pnpm repo:labels`, pushing its own branches,
creating the PR, merging it, filing and labelling follow-up issues, step 8b's design
comments, and deleting its own branches at cleanup. Anything outside that list stops and
asks: a force-push, a hook bypass, a weakened gate, or a new dependency (proposed, then
the run waits for sign-off). Green CI is the go-ahead: as soon as
[step 6](#6-ci-to-green) reports `PASS`, the merge happens in the same turn, with no
"shall I merge?" and no summary-then-wait. Re-confirming per issue defeats `all` mode
entirely. The only pauses are the [Stop conditions](#stop-conditions) and two narrow
asks named inline: a genuinely tied top two at step 2, and `NO_CHECKS` at step 6.

## Modes

| Argument            | Behavior                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_            | Ship the highest-priority shippable issue, then only **its own output** ([step 8c](#8c-take-the-runs-own-output-back-into-the-queue)) — never the wider backlog. |
| `all`               | Ship every shippable issue in dependency-then-priority order; independent ones implemented and reviewed in parallel worktrees, PR → CI → merge serialized.       |
| a number, e.g. `42` | Ship that issue, after checking nothing it depends on is still open.                                                                                             |

A count in the argument ("10個ぐらい", "3 at a time") is `--max-parallel` (default 3,
raised only on request); other hints are `plan.py` filters. A `blocked: design` issue
(or `design=open` in its [ship contract](references/ship-contract.md)) ships only by
number or `--include-design` ([step 2b](#2b-decide-a-design-that-gates-the-pick)).

## Working rules

- **One checkout, one writer.** Step 1 decides once per batch — never re-decide it
  mid-batch: **serial** works in the main checkout, one issue start to finish;
  **parallel** gives each issue a worktree under `<runstate>/worktrees/<n>` and leaves
  the main checkout clean. All GitHub traffic stays in this session, one PR at a time.
- **Nothing waits on the user mid-run.** A command your host's permission settings gate
  behind an approval prompt (typically `rm -rf`) stalls the run: take a prompt-free
  equivalent (`mv` into the holding area, not `rm`), else defer it to the one end-of-run
  confirmation, else run it mid-run only when the issue cannot move without it
  ([closing-out.md](references/closing-out.md#approval-gated-commands)).
- **Inline by default; tiers by name.** On a host with named sub-agents (AGENTS.md
  "Sub-agents"), a brief (`references/agent-*.md`) may go to the `executor` or
  `architect` tier [cost-discipline.md](references/cost-discipline.md#tier-assignment)
  names — by tier name, never a bare model name. A patch round or repeat CI repair on
  the same tier continues the same agent where the host allows.
- **State lives in `<runstate>`** ([run-record.md](references/run-record.md)), never
  inside a checkout — an untracked path there is a hard stop. Record each event as it
  happens with `scripts/run_record.py`; **re-read `<runstate>/run.md` after a context
  compaction** or whenever unsure what this run already did
  ([recovery.md](references/recovery.md#after-a-context-compaction)).
- Scripts (`.agents/skills/shipping-issues/scripts/<name>`) run from the main checkout's
  root; need `git`, `python3`, `gh`, and `AGENTS.md` (plus any host instruction file).

## Workflow

### 1. Plan — one call

```bash
python3 .agents/skills/shipping-issues/scripts/plan.py --mode <all|single|N> \
    [--max-parallel N] [--label L] [--assignee A] [--milestone M] [--include-design] --record
```

Read the block; do not re-derive it ([plan-output.md](references/plan-output.md)).
`preflight: BLOCKED` stops the run; `tree: DIRTY` is a question to ask **now**;
`existing-worktrees: BLOCKED` is a [stop condition](#stop-conditions). **Confirm the
guessed `verify-check:`** — CI's real gate, and it terminates — before step 3 runs it.
`needs-design:` feeds step 8b (background: start now; inline: after the first merge);
`stale-labels:` → run the command it prints, unasked. `labels: COMPLETE` skips step 2;
`github: write=no` → rank from `~P<n>` and report.

### 2. Label the unlabeled — only when the plan says so

≤3 without a settled tier: read them against
[priority-rubric.md](references/priority-rubric.md) and run
`apply_priority_labels.py --backfill --set N=P0 --quiet`. More, tangled edges, or a
close top two: [agent-priority-research.md](references/agent-priority-research.md). Then
re-plan (`plan.py --refresh --record`) and **proceed without asking** unless the top two
are tied on every axis or the pick needs a product decision.

### 2b. Decide a design that gates the pick

Only for a design-blocked issue taken on deliberately: settle, record and clear it
before step 3
([dependency-triage.md](references/dependency-triage.md#deciding-a-held-design)).

### 2c. Confirm the proposed batch

The plan proposes, this step decides: check each issue's real reach against `touches=`
([dependency-triage.md](references/dependency-triage.md#parallel-vs-sequential-all-mode)).
Where step 2's research groups and `plan.py`'s grouping disagree, take the narrower (a
second opinion, not a tie-break). Shrinking never needs asking; no named tiers → serial
(`--max-parallel 1`).

### 3. Implement

**Read [implement-and-review.md](references/implement-and-review.md) first.** Cut the
branch and take a baseline (parallel: `worktree_setup.sh`, the first worktree alone).
Run [agent-implementation.md](references/agent-implementation.md) per issue —
`executor`, `architect` when foundational — and **judge each result here**, `ACCEPTANCE`
first. At most 2 patch rounds on the same tier; a third miss is `NEEDS-CLARIFICATION`.

### 4. Review the branch

One pass per branch, before any PR. **Default:** the read-only, fresh-context review in
[agent-review.md](references/agent-review.md) — `architect` where tiers exist, else
inline. On Claude Code, `/code-review medium <branch>` is the alternative (`high` on
[its triggers](references/cost-discipline.md#review-who-reads-the-diff), never `low` or
`ultra`). Number findings `F1`…, triage them against the issue, fix the accepted ones in
the branch's own checkout, read the fix diff, push
([details](references/implement-and-review.md#review)).

### 5. Open the PR

Serial from here to step 7 in both modes. Open the PR against the default branch with
`Closes #N` in the body, record it, run `link_check.sh <pr> --issue <n> --fix`
([pr-ci-merge.md](references/pr-ci-merge.md#opening-the-pr)).

### 6. CI to green

Once the new head commit shows, `ci_watch.sh` into `<runstate>/ci/<pr>.log` **inside the
host's command timeout** — foreground slices, or background where the host reports
completion; never a hand-rolled sleep/poll loop
([pr-ci-merge.md](references/pr-ci-merge.md#waiting-inside-the-command-timeout)). `FAIL`
→ [agent-ci-repair.md](references/agent-ci-repair.md), ≤3 attempts; `TIMEOUT` past 1800
s in total, `ERROR`, `NO_CHECKS` →
[recovery.md](references/recovery.md#no_checks-error-and-other-non-verdicts).

### 7. Merge and confirm the issue closed

On `PASS`, run `land_pr.sh <pr> --issue <n> --head-sha <sha>` **in that same turn**,
`<sha>` from the log's `head_sha:`. Check `result:` and `issue:` against
[landing-outcomes.md](references/landing-outcomes.md). Then
`git switch <default_branch> && git pull --ff-only` and continue the batch
([pr-ci-merge.md](references/pr-ci-merge.md#after-the-merge)).

### 8. Close out the findings the run turned up

**Fix it in the diff already open** · **file it and ship it this run** · **file it and
leave it**, in that order. **Read [filing-followups.md](references/filing-followups.md)
before filing anything**; it holds the `file_followup.py` call. File right after the PR
that surfaced it lands.

### 8b. Unblock held designs in the background

Every issue filed `--needs-design`, plus step 1's `needs-design:`, gets one
[agent-design-decision.md](references/agent-design-decision.md)
([queue and recording](references/delegation-templates.md#design-decision-step-8b)). On
a host that reports background completion, hand each to `architect` in the background
and keep shipping — cap 3 in flight, start the next as each returns. Otherwise decide
inline, one at a time, between issues: this run's own filings plus **at most 3** backlog
designs; the rest are step 10 lines ("not decided this run"). `DEFERRED` keeps the
label; its question goes to step 10.

### 8c. Take the run's own output back into the queue

Re-plan and ship this run's own follow-ups and newly `DECIDED` issues through steps 3–8
when all hold: **depth 1**, **ready** on the
[readiness gate](references/dependency-triage.md#readiness-gate), and
**[budget left](references/cost-discipline.md#run-budget)**
([how](references/closing-out.md#re-queueing-the-runs-own-output)). Otherwise name it at
step 10; never wait on a design still in flight.

### 9. Clean up

**Once, after the last merge, script only**; `rm` is never used in the run (mid-run,
`mv` into `<runstate>/holding/<n>/`). From the default branch, run `cleanup_run.sh` with
**every branch this run created as `--branch <name>`** — without it every merged-PR
branch goes, other people's included. **Deferred approvals come last, in one ask**, as
the final tool call ([details](references/closing-out.md#cleanup-scope)).

### 10. Report

No prescribed format, but never omit
[these facts](references/closing-out.md#what-the-report-must-not-omit) — above all an
issue left open behind a merged PR, a criterion shipped `not-met`, and every `DEFERRED`
design's open question.

## Stop conditions

Stop the whole run and report when: the plan is `BLOCKED`, a dependency cycle needs a
human to break it, a merge conflict needs a product decision, the repository requires
linear history (`--event blocked --field reason=linear-history`), or the same CI failure
survives the retry ceiling on two different issues.

Also stop on **a change in the repository that this run did not make** — the main
checkout dirty with files no step here touched, a branch moved underneath you, the
default branch ahead of what the last merge left, or a linked worktree under this run's
root that this run did not create. Someone else is working in the same tree. Prove it is
not yours first — compare the actual hunks against what your own branches and worktrees
hold; "it edits a file my issue also edits" is not proof either way — then leave it
exactly as found (no stash, no restore, no commit) and ask. Their uncommitted work is
unrecoverable if you discard it, and a gate failing on their half-finished edit is not
yours to fix. Record before stopping (`--event blocked --field reason=<...>`).

In `all` mode, a single failed issue does not stop the run — mark it FAILED, record it,
skip anything that depended on it, and continue. A `DEFERRED` design is **not** a stop
either; only a design blocking the issue being implemented stops a run
([step 2b](#2b-decide-a-design-that-gates-the-pick)).
