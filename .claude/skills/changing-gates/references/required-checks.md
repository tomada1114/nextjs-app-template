# Required checks and the `main` ruleset

`.github/rulesets/main.json` lists, under `required_status_checks`, the check names a
pull request must report green before it can merge. Each `context` is a job's display
name — `name:` when the job sets one, its id otherwise, with a matrix value expanded —
matched as a plain string. The live ruleset on GitHub is a copy of that file, applied by
hand with `pnpm repo:ruleset`; AGENTS.md's "GitHub settings a new repository must
enable" holds what the ruleset protects and why it has no bypass actor.

Three CI edits therefore move `main.json` in the same pull request:

- **Renaming a job that is a required context**, including its matrix values. Update the
  `context` to the new name.
- **Gating a required job** with a job-level `if:`, a `paths:`/`paths-ignore:` or
  `branches:` filter, a narrower `types:` list, or a move behind a reusable workflow. A
  required check has to report on every pull request, so either drop it from `main.json`
  or keep the job ungated.
- **Adding a job that should block merges.** A new always-on job is not required until
  `main.json` names it; decide which it is and say so in the pull request body.

`tests/ruleset-contexts.test.ts` catches a stale file locally: it fails when a required
context no longer names a job that reports on every pull request. It cannot see the live
ruleset, and it cannot tell that a new job ought to be required.

The committed file changes nothing on GitHub until the owner re-runs
`pnpm repo:ruleset`. That is a settings write: the agent proposes it in the pull request
body and does not run it. Timing matters. A context the pull request _adds_ is applied
after merge. A context it _renames or drops_ blocks that same pull request, because the
live ruleset still waits for the old name, which no longer reports — so the owner
applies the new file from the branch just before merging, and other open pull requests
then wait on the new name until they are rebased.
