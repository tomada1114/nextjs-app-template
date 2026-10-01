# Cost discipline

What this skill keeps out of the main context, why the run count is what it is, and why
each brief goes to the tier it goes to. Read it when deciding whether to delegate a
step, before changing a run count, or before choosing how a branch is reviewed.

## Table of Contents

- [Review: who reads the diff](#review-who-reads-the-diff)
- [What the startup costs](#what-the-startup-costs)
- [Run budget](#run-budget)
- [Tier assignment](#tier-assignment)
  - [The foundation exception: `architect` for what the backlog builds on](#the-foundation-exception-architect-for-what-the-backlog-builds-on)
  - [The floor: too small to delegate](#the-floor-too-small-to-delegate)
- [What parallel mode costs](#what-parallel-mode-costs)

The main context holds the selection and the verdicts, nothing else. Issue bodies go to
the triage agent, diffs stay in the sub-agent run that produced them, CI logs and verify
output reach the parent through a file rather than through the prompt. If you find
yourself about to read a full GitHub API JSON blob, a workflow log, or an unrelated part
of a diff in the main context, that is the signal to delegate or scope the read instead.

Labeling is the cheap half of this by design: the backfill is a pure script pass with a
one-line summary, and re-deriving priority from issue prose happens once per issue —
ever — because the answer is written back to GitHub. On a labeled backlog the whole
ranking step is `--select`, three lines, no spawn at all. Never re-read bodies to
reconstruct a priority a label already carries; if a label looks wrong, fix the label.

## Review: who reads the diff

Only for [step 4](../SKILL.md#4-review-the-branch)'s local pass.

**The standing review is a read-only, fresh-context diff review** from
[agent-review.md](agent-review.md): handed to `architect` where the host has named
sub-agents — its reads stay in that agent's context, and only the numbered findings come
back — otherwise followed inline. An inline review of a diff this session wrote itself
is a self-review: it still runs, and the step 10 report calls it that rather than
presenting it as independent.

On Claude Code, `/code-review` is an alternative to the brief, with the effort first and
the branch second (`/code-review medium <branch>`):

| effort   | when                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `medium` | **the default** for this path                                                                                                                                              |
| `high`   | the change can lose or corrode data that already exists — a migration, a storage-layer write, a released public contract real consumers are on — or the user asked for one |

Diff size or file count alone is not a reason to escalate — a big mechanical rename is
exactly the shape the default handles well. Never `ultra`: it runs in the cloud, is
billed per use, and the prompt that defines it says explicitly that a model cannot
launch it itself.

### Never `low`: a diff it cannot see

`low` **skips test and fixture hunks**. That is wrong whenever the file under `tests/`
_is_ the gate rather than a consumer of one — a file that lints workflow YAML, asserts
zone or import boundaries, walks the tree for secrets or placeholders, or otherwise
decides what "green" means — and it fails silently: a diff confined to such a file comes
back `(none)` in a few seconds, which reads exactly like a clean review and is not one.
The same reading applies to any review result: **a clean verdict that names what it
skipped is not a clean verdict.** Read the sentence, not the empty findings list.

Observed cost of getting this wrong: a gate change reviewed at `low` returned no
findings; re-run at `medium` it returned four, all reproduced against the branch, one of
them a security rule that silently accepted three of the four YAML spellings it existed
to reject.

## What the startup costs

Steps 0 through 2c are one `plan.py` call and one `gh` fetch pair — preflight, ranking,
selection, repo profile and grouping in a single block. Two things keep it there, and
both are easy to undo by accident:

- **The digest cache.** Every `issue_digest.py` call inside the same few minutes reads
  the fetch the plan already paid for; `--issue`, `--detail` and `--body-chars` all
  filter data already in hand rather than re-fetching it. What breaks this is asking the
  same question in three calls — a `--select`, then a `--rank-only`, then a list of
  `--issue` numbers — which is what `--with-rank` and `--detail-top` exist to collapse.
  Pass `--refresh` only after this run changed the backlog; passing it habitually turns
  the cache off.
- **The reference files.** `dependency-triage.md` and `worktree-parallelism.md` are ~380
  lines between them and are _not_ hot-path reading any more. The plan answers what they
  used to be read for; open them when it says `PARTIAL`, when a gate fails, or before
  cleanup — not on every run.

The one thing worth spending on at startup is `issue_digest.py --detail-top K` when the
picked issues' bodies genuinely have to be read. That is still one call, and it is
bounded by K.

## Run budget

Run count scales with issue count, not with thoroughness: one triage spawn (optional),
one implementation sub-agent per issue plus up to 2 resume/patch runs when this
session's judgment finds the first incomplete, one review per branch, one fix run per
branch that had accepted findings (none when a review came back clean), one repair run
per failing CI attempt (capped at 3). This session's own judgment calls — reading the
implementation diff, reading a fix run's diff, deciding what CI failure means — cost
targeted reads in this context, never a spawn. Filing a follow-up (step 8) never adds a
run either: whatever found it already returned the lead under `FOLLOW-UPS`, and
confirming it costs a couple of targeted reads.

Two things scale that count beyond the issue list itself, both deliberately bounded:

- **Design decisions (step 8b)** — one `architect` run per design-blocked issue, capped
  at 3 in flight when they run in the background. Inline (no background completion),
  each is one decision this session makes between issues: this run's own filings plus at
  most 3 backlog designs, and every one counts against the run budget like a patch round
  — the rest wait for the next run. Run in the background, they cost nothing in
  wall-clock on the shipping path (nothing ever waits on one) and almost nothing in this
  context: what comes back is a verdict and a two-line approach, while the design itself
  goes to the issue. Run inline, each costs the reads one decision needs, between two
  issues. What they buy is a backlog that stops accumulating undecided work — the single
  most expensive thing a backlog can hold, because every future ranking pass re-reads it
  and skips it again.
- **Shipping the run's own follow-ups (step 8c)** — a full steps 3–8 cycle per
  follow-up, the same cost as any issue. This is why depth is capped at 1: a run that
  shipped what it filed, and then what _that_ filed, has no termination condition and no
  budget the user agreed to. Depth 1, then stop and report.

## Tier assignment

Every step runs inline unless the host has named sub-agents (AGENTS.md's "Sub-agents").
Where it does, a brief goes to a tier **by name**, never by a bare model name: the tier
pins its own effort, which a per-spawn `model` cannot carry.

| Brief                      | Tier                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Priority research (step 2) | `executor`                                                                                                      |
| Implementation (step 3)    | `executor`; `architect` when [foundational](#the-foundation-exception-architect-for-what-the-backlog-builds-on) |
| Review (step 4)            | `architect`                                                                                                     |
| Review fix (step 4)        | `executor`                                                                                                      |
| CI repair (step 6)         | `executor` for attempts 1–2; `architect` from attempt 3                                                         |
| Design decision (step 8b)  | `architect`                                                                                                     |

Implementation, priority research and review fixes are fully specified work with a clear
pass/fail — the `executor` shape — with one standing exception below. CI repair
escalates once the same failure survives two attempts in a row: persistent failure is a
sign the spec (or the fix) needs more judgment, not more mechanical retries. Review and
bug finding is `architect` work with genuinely unresolved spec. Design decisions are
`architect` for the same reason and more so — deciding an approach nobody has decided is
the least mechanical work this skill delegates, and a bad decision recorded on an issue
outlives the run that made it. It is also the only brief here that writes to GitHub (one
comment, one label) and the only one that writes no code at all. `worker` takes nothing
in this skill: every brief here needs repository tools.

### The foundation exception: `architect` for what the backlog builds on

Some issues are not "fully specified work with a clear pass/fail" even when their body
is excellent, because what they produce is a **shape other issues copy** rather than a
behavior a test pins down. Hand the step 3 implementation to **`architect`** when the
issue is any of:

- **Architecture or a skeleton** — the directory layout, the app/router skeleton, the
  composition root, a zone or module boundary.
- **An interface, port, or schema** — a public contract, an adapter boundary, an error
  taxonomy, a data shape. The first implementer fixes the vocabulary every later one
  inherits.
- **A skill, instruction file, or gate design** — a `SKILL.md`, `AGENTS.md`, a host's
  own instruction file, a lint rule that encodes a convention, a CI job that defines
  what "green" means. These are prompts and policies: they are read by every future run,
  and a mediocre one degrades work long after this run ends.

The test is not difficulty, it is **blast radius**: would a wrong call here be cheap to
correct in its own follow-up, or would it be copied by every issue after it? Only the
second earns `architect`.

Signals visible before spawning, straight off `issue_digest.py`: an `unblocks×N` of 2 or
more, a `foundation`/`schema`/`interface` signal, or a Done-means written as a structure
to establish rather than a behavior to observe. Any one of those is a reason to look;
the blast-radius test decides.

Everything else stays on `executor`, which is most of a backlog: bug fixes, removals,
mechanical rewrites, config edits, documentation that follows a shape already settled,
and any issue whose Done-means is a command that passes. A removal-only issue is
`executor` even when it is `P0` and unblocks the whole chain — deleting what a decision
already condemned carries no design in it.

The same escalation applies to a resume/patch run: it stays on the tier the first run
used — continuing that same agent where the host allows — because a foundation the first
run got half-right is exactly where the remaining judgment sits.

Where tiers exist, implementation stays delegated even when this session could do it
itself — bought for context isolation: the diff and the repo exploration are never
needed in the main context again once this session has judged the result.

### The floor: too small to delegate

That exception buys context isolation, and an issue with almost no context to isolate
does not repay it. Below a certain size the handoff costs more than the work: writing a
self-contained prompt, waiting, reading the report, then re-deriving enough of the diff
to judge it — for a change this session could have made and verified in a couple of
commands.

Implement it directly when **all** of these hold:

- the whole change is a handful of lines in one or two files, and this session already
  knows which lines from the issue body or a finding it just read;
- there is no exploration to do — nothing to search for, no unfamiliar module to learn;
- the verification is a command whose output this session reads anyway (`pnpm audit`,
  one test file, the gate);
- it is not foundational by the test above. A three-line change to an interface or a
  gate is still foundational — size is not the same question as blast radius, and this
  floor never overrides that section.

A dependency pin closing a named advisory, a one-line config fix a review turned up, a
stale reference in an instruction file: these are the shape. Say in the step 10 report
that the run implemented it directly, so the choice is visible rather than looking like
a skipped step.

Everything above that floor — anything with a file to find, a module to read, or a test
to design — stays delegated wherever tiers exist.

## What parallel mode costs

Parallel mode does not reduce the number of runs — the same issues need the same
implementations. What it changes is when they happen, and what has to be set up first.

**Added, per issue in a parallel batch:** one dependency install and one baseline verify
(`worktree_setup.sh`), both outside this context — the parent reads one `verdict:` line
each. The review and its fix run are the same per branch in either mode — only where
they write differs.

**Saved:** the implementations overlap instead of queueing, which is the longest stretch
of a run, and nothing in this context grows to pay for it — each sub-agent's exploration
and diff still stay inside its own run.

The break-even is group size. One issue in a group means paying the setup for no overlap
at all, which is why the plan refuses to parallelize a group smaller than 2. The default
cap of 3 comes from somewhere else entirely — rebase churn as the default branch moves
under the batch — not from cost, which is why `plan.py --max-parallel` can raise it when
the user asks for more and why nothing else should. Every issue past 3 in a batch is
another branch that has to be brought forward after each merge in the batch, and that
churn grows with the square of the group, not with it.

A repo that fails the viability gate costs one worktree's setup to discover, once per
run. The answer is a property of the repository, not of any issue: never re-test it per
issue.
