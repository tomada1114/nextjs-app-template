# Landing the approved dependency plan

Use this after the exact plan in SKILL.md is approved. Keep each remote action within
that recorded scope and follow AGENTS.md's Git/GitHub routing and safety rules.

## Individual PRs

Process approved PRs in ascending number, one at a time. Immediately before each merge,
verify its current head, the complete required check set, feedback and required
approvals. Confirm the merged state and landed commit afterwards.

An earlier approved merge can leave a later approved PR behind the base. Request the
necessary bot rebase covered by the plan, then observe the changed head and new checks.
For a Dependabot PR, the planned comment is:

```text
@dependabot rebase
```

That comment is a request, not a successful rebase. Never merge on checks for its old
head, and never send a Dependabot command to a Renovate PR. A rerun is allowed only for
the run/job and reason the plan covers; a newly needed one requires fresh approval.

## Combined PR

Start an owned, clean worktree and branch from the current default-branch commit. Record
the base and the exact approved packages/ranges. Read each approved PR's full diff to
learn the intended changes; do not integrate its commits or resolve a conflict by
picking whichever version is higher.

Apply one approved change at a time with its owning tool:

```bash
pnpm add '<package>@<approved-range>'
pnpm add -D '<dev-package>@<approved-range>'
```

Pass the exact reviewed range, preserving the manifest's existing caret, tilde or
exact-version style and dependency section. An already-present framework companion can
be updated only to the target named in the approved family completion. A new package is
a separate dependency decision, even when it belongs to that family.

For an Action, edit only the approved `uses:` pin: copy the full new SHA and the
`# vX.Y.Z` version comment from the reviewed PR exactly. Changes to permissions,
triggers, secrets or source require the separate decision in SKILL.md.

### Review the lockfile

Let pnpm generate `pnpm-lock.yaml`; never resolve or edit it by hand. Compare the
manifest and lockfile diff with the union of the approved PR changes and the explicitly
approved family completion. Read resolved versions, sources, integrity values and
transitive changes, not merely the top-level manifest.

Every changed package must be named by those reviewed diffs or the family completion. If
an unrelated package moves, restore its approved baseline through the owning tool and
regenerate the lockfile. Do not retain the change just because installation succeeds. A
new package, source or build allowance invokes "Stop and ask"; if eliminating unapproved
movement needs a new override or policy change, retain the evidence and ask.

### Verify and publish

```bash
pnpm install --frozen-lockfile
pnpm check:source
```

Apply only settled mechanical fixes inside the approved scope. A migration, new
dependency, changed supply-chain decision or weakened check is not such a fix.

Commit with the normal hook, inspect the committed tree, and push only the approved
branch. Open or update its PR against the recorded default branch with a Conventional
Commit title and `.github/pull_request_template.md`. Include the exact approved original
PRs, package versions and family completion, the lockfile review, executed checks,
release-note findings, and the approved stopping point.

Wait for all required current-head CI, review and approval evidence. A correction push
invalidates the previous head's evidence. Diagnose a required failure instead of waiting
passively; a new rerun or decision outside the plan needs fresh approval.

## Confirm landing before closing originals

For an approved merge, re-read the head and default branch at the landing boundary;
merge only the verified head and confirm the returned merge commit and PR state. An
approved PR-only run leaves the combined PR and originals open.

After a confirmed combined merge, close only the approved superseded originals with a
pointer to the combined PR, then delete only branches the plan authorized. Confirm each
closure and deletion. If the combined PR remains open or is abandoned, leave the
originals open. Report partial cleanup separately from a successful merge.
