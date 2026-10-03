---
name: merging-dependency-prs
description: >
  Use when landing open Dependabot or Renovate pull requests, clearing a backlog of
  dependency updates, or several PRs contest the same lockfile. Covers the read-only
  survey, pre-1.0 minor updates treated as major risk, review of source and lockfile
  changes, coordinated framework families, an exact approval plan, individual merges or
  a combined branch built with the owning package tool, and closing originals only after
  their replacement lands.
---

# Merging Dependency PRs

**Owns:** landing already-open dependency PRs: survey, review, approval scope, landing
mode, the combined branch, and cleanup. **Does not own:** whether a package may be added
or bumped, the release-age cooldown, or supply-chain settings (`managing-dependencies`).

## Operating contract

- **Input:** all open bot PRs, or an explicitly selected subset.
- **Output:** verified merged PRs or a combined PR, plus held and superseded originals.
- **Approval:** do the survey and review first, present the exact plan below, then wait
  for one approval covering that plan. Carry out its approved actions without asking
  again per merge. Green CI and a branch choice provide no write authorization.
- **Boundary:** keep each check tied to the current head; honor repository-required
  checks, review, human approval, and the approved stopping point independently.

## Step 1: Survey

```bash
node .agents/skills/merging-dependency-prs/scripts/survey-prs.mjs
```

This script is read-only; `--json` exposes the same rows for a plan. If no selected bot
PR remains, report that and stop. Record ecosystem, versions, risk level, CI state,
merge state and contested paths. The survey marks a parsed 0.x minor change as `major`
and sets `preOneMinor`, so the plan names that risk explicitly.

A grouped title can hide its members: inspect the whole diff and each manifest change,
rather than deriving the group's risk from its title alone. A missing or unknown version
is a reason to inspect, never a patch classification.

## Step 2: Review and coordinate

Run the [review checklist](references/review-checklist.md) for every selected PR before
making the plan. Diagnose failing checks with
[failure modes](references/failure-modes.md). Read upstream release notes for every
major, including a 0.x minor promoted to major.

Treat a framework family as one reviewed unit:

- `next` and `eslint-config-next` stay on the same version line.
- `react`, `react-dom` and `@types/react` move together, with `@types/react-dom` when it
  is present.

If open PRs leave a family split, complete it on the combined branch and list the exact
companion packages and target ranges in the plan. Adding a package still needs the
separate dependency decision that `managing-dependencies` owns. A framework major needs
the migration decision in "Stop and ask" before it becomes eligible.

## Step 3: Choose a mode and get approval

Merge individually only when at most three eligible PRs have no contested paths and each
is clean with passing current-head checks. Otherwise build a combined PR: more PRs,
overlapping paths, or a lockfile needing regeneration favor that route. Mixed outcomes
are allowed; name the mode for each PR.

The survey's passing rollup is a classifier, not the complete gate: confirm that every
expected required check actually registered and passed for the head being landed.
Pending, missing or unrecognized results hold the PR.

### The approval gate

Present one concrete plan that names:

- Every selected PR, its reviewed head and diff, landing mode, exact packages and target
  ranges, every major/0.x minor, the release-note review, and any family completion.
- Branch creation, commits and pushes, PR creation/update, which PRs will merge, and
  which originals and branches will close or be deleted after a combined merge.
- Every planned `@dependabot rebase` comment, with its target PR, and every CI rerun,
  with its run/job ID and reason. Use a bot's supported route only for that bot.
- The rebases that an earlier approved merge may force on the remaining approved PRs.
  The one approval covers those necessary rebases too; Step 4 revalidates each new head.
- Which cases are held for a separate decision, and whether the run stops at an open
  verified combined PR or at a merge.

Wait for approval and record that scope. A new PR, package, major, rerun, comment or
landing mode outside it needs fresh approval. "Stop and ask" applies outside any batch
approval; do not stretch a green check or an approved package into another decision.

## Step 4: Execute the approved plan

Follow [landing and lockfile verification](references/landing.md) for the selected mode.
The combined branch starts from the current default branch and applies approved bumps
with their owning tool; it never integrates a bot branch's commits.

For npm packages, preserve the manifest's range style with `pnpm add` or `pnpm add -D`.
For an Action, copy the approved full SHA and its version comment exactly. Inspect the
regenerated lockfile against the approved PR diffs and family completion: eliminate
unapproved package changes with the owning tool, never by hand-editing the lockfile. If
that cannot be done inside the approved plan, stop and retain the evidence.

Record the head covered by every review. Any changed head, including a bot rebase,
invalidates the old-head evidence: repeat Step 2's complete diff, release-note,
Action-pin and lockfile review before proceeding. Compare the new content with the
approved plan; hold a change outside that scope for fresh approval. This applies to
individual PRs and combined branches, even when the rebase itself was already approved.

Run the repository's local gate, then recheck the exact published head's CI, feedback,
and required approvals before merging. Resolve only settled mechanical failures in
scope; a migration or other judgment call is held for the human.

Close superseded originals with a pointer only after the combined PR is confirmed
merged. If it is left open or abandoned, the originals stay open too.

## Stop and ask

These require a separate decision even if a batch was approved:

- An Action update that widens `permissions:`, adds a secret, or changes a trigger.
- A maintainer, owner or source change, including a new registry or repository source.
- A new package in the lockfile or a new `allowBuilds` entry; an unrelated package
  update not named by the approved PR diffs or family completion.
- A bump that is green only after relaxing a gate, supply-chain setting or Action pin.
- A framework major, whose migration must be explicitly approved before this workflow
  plans its landing; a newly discovered breaking change outside the approved plan.
- A conflict or failure whose resolution changes application behavior or needs a new
  dependency/architecture choice.

AGENTS.md's security rules apply: never `--admin`, `--no-verify`, force-push, unpin an
Action or weaken a gate to land a bump. Retain the PR and worktree when stopped.

## Step 5: Report

Report each merged PR and what landed, each held PR and its reason, each confirmed
superseded closure, and any real CI error with its job/head evidence. Include the
approved plan, package/lockfile review, local checks, final heads and remaining work.
Partial execution is reported as partial, never as a completed batch.
