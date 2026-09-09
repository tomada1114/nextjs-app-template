# CI Failure Modes on Dependabot PRs

Read this when the survey reports `checks=FAILING`. Diagnose before deciding — most
failures here are mechanical, not regressions.

Pull the real error first:

```bash
gh run list --branch <branch> --limit 1 --json databaseId -q '.[0].databaseId' \
  | xargs -I{} gh run view {} --log-failed
```

Which _step_ failed is the fastest way to tell these apart. F1 to F3 fail before any
project code runs, at `pnpm install`; F4 onward fail inside a check, in the order CI
runs them — format, lint, typecheck, build, then tests.

## F1 — Peer range conflict (`strictPeerDependencies`)

**Symptom:** every job fails at `pnpm install --frozen-lockfile` with an unmet-peer
error. The PR bumps one package, and the name in the error is a different one.

**Cause:** `pnpm-workspace.yaml` sets `strictPeerDependencies: true`, so an unmet or
conflicting peer range is a hard failure rather than a warning. The standing example is
`typescript`: `typescript-eslint` is the one package capping it, and it caps at a
**minor**, not merely below the next major, so a `typescript` bump inside the current
major can fail here too (`managing-dependencies` owns the ceiling and the command that
reads the real range). A PR proposing a version past it is **correct to fail**.

**Fix:** hold the PR. Raising the `typescript` ceiling is a coordinated upgrade of both
`typescript` and `typescript-eslint` at once — not a routine bump. For any other
package, the only sanctioned way through is a `peerDependencyRules.allowedVersions`
entry naming one `parent>child` edge, and adding one asserts the package really works
against the version it did not declare — that is a reviewed dependency decision, not
something a bot PR carries. Never relax `strictPeerDependencies` itself. Say so in the
report and let a human decide.

## F2 — Lockfile out of step with the manifest

**Symptom:** every job fails at `pnpm install --frozen-lockfile`, complaining that the
lockfile is not up to date with `package.json`.

**Cause:** the manifest constraint changed without a matching lockfile update — usually
after a rebase or a manual conflict resolution.

**This is not a regression.** The bump itself is untested, not broken.

**Fix:** the PR cannot be merged as-is. Take it through the combined-PR path (SKILL.md
Step 4b) and run `pnpm install --lockfile-only` there. Only after the lockfile is
regenerated does CI actually test the new version, so treat the combined PR's CI run as
the first real signal for these bumps.

## F3 — Cooldown rejection (`minimumReleaseAge`)

**Symptom:** install fails because a requested version cannot be resolved, and the
version named in the error was published recently (see `pnpm-workspace.yaml`'s
`minimumReleaseAge`).

**Cause:** the `minimumReleaseAge` cooldown in `pnpm-workspace.yaml`, mirrored by
`.github/dependabot.yml`'s `cooldown`, so this normally cannot happen — except for
**security updates**, which Dependabot exempts from its own cooldown.
`managing-dependencies` owns the cooldown and its exception process.

**Fix:** this is the one case where the tension is real: a security fix you want now
against a cooldown that exists to catch a compromised release. Report the advisory, the
affected version, and its publish date. A human must decide whether to wait out the
remaining days or add that exact `package@version` to `minimumReleaseAgeExclude` in the
reviewed dependency PR. Never add a wildcard or package-only exclusion, and record when
the exception will be removed after the version ages out.

## F4 — Genuine tooling regression

**Symptom:** install succeeds; a later step fails — `pnpm run lint`,
`pnpm run typecheck`, or `pnpm run format:check`.

**Cause:** the new tool version added a rule, changed a default, or tightened inference.
Common with ESLint, typescript-eslint, TypeScript and Prettier bumps.

**Fix:** mechanical fixes (apply the new lint, add a missing annotation, run `pnpm fix`
for a Prettier formatting change) belong on the branch. If the new version demands a
real design decision or a config change with tradeoffs, hold the PR and report what it
wants. Never silence it with `@ts-expect-error` or an `eslint-disable` to land the bump.

## F5 — The application no longer builds

**Symptom:** formatting, lint and typecheck pass; CI's `Build` step fails at
`pnpm run build` (`next build`). Often the only failing step.

**Cause:** a bump to `next`, `react`, `react-dom`, `next-intl`, or anything
`next.config.ts` loads. `next build` compiles the App Router tree, runs the framework's
own plugins, and type-checks the route entry points — a surface no unit test reaches, so
it is the first place a framework bump shows up.

**Fix:** reproduce it locally, since the CI log truncates the part that matters:

```bash
pnpm install --frozen-lockfile && pnpm run build
```

A renamed config key or a moved export named in the upstream migration note is
mechanical and belongs on the branch. A failure that needs an App Router change — a
changed route or layout signature, a newly required export — is a migration rather than
a bump: hold the PR and report what the release notes ask for. Never drop the build step
and never reach for `typescript.ignoreBuildErrors` or `eslint.ignoreDuringBuilds` in
`next.config.ts` to get past it.

## F6 — Test or coverage failure

**Symptom:** lint and types pass; `pnpm run test:coverage` fails, or coverage drops
below one of the floors in `vitest.config.ts` (see `placing-tests`).

**Fix:** this is a real signal. Read the failure. Hold the PR and report it — do not
chase coverage by editing tests to accommodate a dependency you have not decided to
accept, and do not lower the threshold.

## F7 — Merge state `BEHIND` or `DIRTY`

Not a CI failure. `BEHIND` means main moved; `DIRTY` means a real conflict.

```bash
gh pr comment <number> --body "@dependabot rebase"
```

Dependabot rebases within a minute or two, then checks re-run. If it conflicts
repeatedly — which is common once two npm PRs are open, since both touch
`pnpm-lock.yaml` — fold the PR into the combined branch and resolve there.

## F8 — Check never reports

**Symptom:** `checks=PENDING` that never resolves, or `checks=NONE`.

**Cause:** workflow concurrency cancellation, or a workflow whose triggers do not fire
for the bot's PRs.

**Fix:** re-run with `gh run rerun <run-id>`. Never merge a PR whose checks never
actually ran — a missing check is not a passing check.

## F9 — Unrecognised or absent conclusion

**Symptom:** `checks=FAILING` naming a check as `<name>=STARTUP_FAILURE`,
`<name>=STALE`, or `<name>=UNKNOWN`.

**Cause:** the check did not finish in a state the classifier vouches for.
`STARTUP_FAILURE` means the runner never got the job started; `STALE` means GitHub
superseded the result; `UNKNOWN` means the rollup entry carried neither a conclusion nor
a status, which is the shape an API change or a partially-written check produces.

**Fix:** none of these is a test failure, so do not read the diff for a cause — open the
run and find out why it did not complete, then `gh run rerun <run-id>`. The verdict is
the classifier declining to vouch for the check, not a report that the check failed;
`PASSING` is an allow-list of `SUCCESS`, `NEUTRAL` and `SKIPPED`, and everything else is
held deliberately. A state that ought to pass and does not is a bug in
`scripts/lib/pr-checks.mjs`, not a reason to merge past it.

## Security review checklist

Read this before approving any PR at Step 2 — this is the point of the gate, not a
formality:

- GitHub Actions bumps must remain **SHA-pinned with a version comment**. A diff that
  replaces a SHA pin with a floating tag is a regression — hold it.
  `tests/workflows.test.ts` asserts this, so such a PR should already be red.
- For a major bump, read the upstream release notes before approving:
  `gh release view <tag> --repo <owner>/<repo>` or the changelog link in the PR body.
- Treat a **minor bump of a `0.x` package as a major** one — pre-1.0 tools ship breaking
  changes in minor releases. The survey script labels these `minor`; you still read the
  release notes.
- Confirm the `Review new dependencies` check passed on the PR — it is the advisory gate
  for new and changed dependencies.
- A bump that changes `pnpm-workspace.yaml`, `eslint.config.mjs`, or anything under
  `.github/workflows/` is changing _what_ runs rather than _which version_ runs, and
  deserves a closer read.
- Never let a bump relax a `pnpm-workspace.yaml` supply-chain setting or add an
  `allowBuilds` entry to make an install succeed — see `managing-dependencies` for what
  each setting closes off. Each is a supply-chain decision, not a merge conflict.
