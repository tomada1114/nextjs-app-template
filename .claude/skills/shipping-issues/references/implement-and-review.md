# Implement and review (steps 3–4)

The detail behind [SKILL.md step 3](../SKILL.md#3-implement) and
[step 4](../SKILL.md#4-review-the-branch): from a branch cut off the default branch to a
reviewed, fixed, pushed branch with no PR yet. Read it before the first step 3 of a run.

## Table of Contents

- [Setting up the branch](#setting-up-the-branch)
- [Handing off the implementation](#handing-off-the-implementation)
- [Judging the result](#judging-the-result)
- [Review](#review)
- [Triage and fixes](#triage-and-fixes)

## Setting up the branch

One issue = one branch = one PR. Step 1's `next:` line is the command.

**Serial** —
`git switch <default_branch> && git pull --ff-only && git switch -c <branch>`, then run
the confirmed verification command **once, unmodified, on this branch**, redirected to
`<runstate>/verify/<n>-baseline.log`.

**Parallel** — the script creates each branch, copies untracked local config, installs
dependencies, and runs the baseline (bounded). It **reports and does not decide**:

```bash
git switch <default_branch> && git pull --ff-only   # once, before the batch
.agents/skills/shipping-issues/scripts/worktree_setup.sh --spec <n>:<branch> \
    --spec <m>:<branch> --base <default_branch> --root <runstate>/worktrees \
    --log-dir <runstate>/verify --verify "<confirmed verify command>"
```

**Provision the first worktree on its own, read its block, then ask for the rest** —
that one extra call is what stops a repo that cannot carry a worktree from costing three
dependency installs instead of one. Judging the four `baseline:` outcomes is yours, not
the script's ([all four](recovery.md#a-red-baseline); `verdict:` semantics
[here](worktree-parallelism.md#viability-gate)). Read exit codes and log tails, never
full output; what the smoke run turns up goes to step 8.

## Handing off the implementation

Fill [agent-implementation.md](agent-implementation.md) per issue
([delegation-templates.md](delegation-templates.md) holds the rules every brief shares).
Where the host has named sub-agents, hand it to **`executor`** by default and to
**`architect`** when the issue is foundational — blast radius, not difficulty
([the foundation exception](cost-discipline.md#the-foundation-exception-architect-for-what-the-backlog-builds-on)).
A change small enough that the handoff costs more than the work is implemented here
rather than handed off
([the floor](cost-discipline.md#the-floor-too-small-to-delegate)). With no tiers — a
host without named sub-agents, or a Codex CLI checkout whose `.codex/` layer is not
loaded because the project is untrusted — follow the brief inline, one issue at a time,
and run the batch **serial**: plan with `--max-parallel 1` and create no worktrees. Each
worktree costs a dependency install and a baseline, and with one writer working through
them in turn it buys no concurrency.

In parallel mode hand off every brief in the batch **before waiting on any** — in one
message where the host batches spawns — each with its own worktree path, never the main
checkout.

## Judging the result

**Judge each result in this context**, against the issue and step 2b's decision. What
each returned field is for:

| Returned field               | Consumed                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCEPTANCE`                 | **Here, first.** A `not-met` line is work still owed. Sending it back costs one patch round; letting it through merges a PR that closed an issue it did not answer. Green CI does not cover this — it proves the repository still works, not that the issue was answered. |
| `UNRESOLVED`                 | **Here.** Judgment calls the agent made alone: each is accepted (and stated at step 10) or sent back, never silently inherited.                                                                                                                                           |
| `PR-SUMMARY` / `TEST-PLAN`   | [Step 5](../SKILL.md#5-open-the-pr), verbatim.                                                                                                                                                                                                                            |
| `MEASURE`                    | [Review](#review) — what review findings are checked against.                                                                                                                                                                                                             |
| `SCOPE-NOTES` / `FOLLOW-UPS` | [Step 8](../SKILL.md#8-close-out-the-findings-the-run-turned-up).                                                                                                                                                                                                         |

At most **2 patch rounds** on top of the first run, on the same tier — continuing the
same agent where the host allows, a fresh one only on a tier change. A third miss is
`NEEDS-CLARIFICATION`, not another round. A run that returned without a report, stopped
before pushing, or missed or widened the spec: [recovery.md](recovery.md) — never
re-spawn an agent that returned without its report.

## Review

Run against the branch, before any PR exists. In parallel mode this covers the whole
batch: review each branch, triage all of them, then fix them concurrently — no PR opens
until the batch's last review is triaged. This is a single pass: fix every accepted
finding here, and route out-of-scope and `pre-existing` findings to
[step 8](../SKILL.md#8-close-out-the-findings-the-run-turned-up) — do not re-review
after the fix.

**The default is a read-only, fresh-context diff review**: fill
[agent-review.md](agent-review.md) and hand it to **`architect`** where the host has
named sub-agents, or follow it inline — as a separate pass that reads the diff as a
change against the issue
([a review with no second context](recovery.md#a-review-with-no-second-context)). It
returns findings numbered `F1`, `F2`, … and out-of-scope items `O1`, `O2`, …;
`INTENT-MATCH: no` is read before the findings.

**On Claude Code, `/code-review medium <branch>` is an alternative** — effort first,
branch second: an unrecognized first token makes the _entire_ string the target and
silently falls back to the last effort used. `high` only on the triggers in
[cost-discipline.md#review-who-reads-the-diff](cost-discipline.md#review-who-reads-the-diff);
never `low`, which skips test and fixture hunks and returns a false clean on a diff that
lives under `tests/`, and never `ultra`. Its `--fix` is serial-mode only
([why](recovery.md#--fix-and-why-it-is-serial-mode-only)). Number its findings `F1`,
`F2`, … yourself before handing any over.

Whatever path ran, check what the review actually read before believing an empty
findings list: a clean verdict that names what it skipped is not a clean verdict.

## Triage and fixes

Triage before anything is written, and in parallel mode for the whole batch first: read
every finding against the issue's scope, send what belongs in this diff, route the rest
to step 8. "Belongs in this diff" is the same behavior change the issue is about, tests
included — a sibling case of the bug just fixed belongs here; a schema change or a new
public surface does not, however small the patch looks
([filing-followups.md](filing-followups.md)).

Apply the accepted findings **in the branch's own `<workdir>`** — never the main
checkout in parallel mode, which sits on the default branch: inline, or by handing
[agent-review-fix.md](agent-review-fix.md) to **`executor`**, one brief per branch, all
handed off before waiting on any. A branch with zero accepted findings gets no fix run.
**Keep the caller-assigned numbers** — the fix brief returns `APPLIED`/`REJECTED`
against those same `F<n>`, and without them the returned lines cannot be matched back to
what was sent.

When anything other than this session wrote the fixes — a fix agent or `--fix` —
**reading what the fix pass changed is the safeguard**:
`git -C <workdir> diff <impl-commit>..HEAD`, not the whole branch. Revert what it got
wrong. Read the findings it would _not_ apply (`skipped` from `--fix`, `REJECTED` from
the brief) — neither is clean; real-but-out-of-scope goes to step 8. Re-run the
verification command **in `<workdir>`** only if something actually changed, then push.

Record, per branch:
`--event review --field issue=<n> --field status=<review|review+fix> --field by=<architect|inline|self|code-review-medium|code-review-high> --field findings=<n> --field skipped=<n>`
— `skipped` counts refusals from either path.
