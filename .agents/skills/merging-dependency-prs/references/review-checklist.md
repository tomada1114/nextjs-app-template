# Reviewing dependency PRs

Read this before approving any PR at Step 2 — this is the point of the gate, not a
formality. Step 4 repeats this review whenever a head changes:

- Read the complete current diff, including manifests and the generated lockfile's
  resolved versions, sources, integrity values and transitive changes. For an approved
  plan, verify the content still fits its packages, ranges and family completion; follow
  the [lockfile procedure](landing.md#review-the-lockfile) for unapproved movement.

- GitHub Actions bumps must remain **SHA-pinned with a version comment**. A diff that
  replaces a SHA pin with a floating tag is a regression — hold it.
  `tests/workflows.test.ts` asserts this, so such a PR should already be red.
- For a major bump, read the upstream release notes before approving:
  `gh release view <tag> --repo <owner>/<repo>` or the changelog link in the PR body.
- Treat a **minor change of a `0.x` package as major risk**. The survey reports it as
  `major` with the `preOneMinor` flag; call it out and read the release notes. Inspect
  each member of a grouped PR when its title carries no versions.
- Confirm the `Review new dependencies` check passed on the PR — it is the advisory gate
  for new and changed dependencies.
- A bump that changes `pnpm-workspace.yaml`, `eslint.config.mjs`, or anything under
  `.github/workflows/` is changing _what_ runs rather than _which version_ runs, and
  deserves a closer read.
- Never let a bump relax a `pnpm-workspace.yaml` supply-chain setting or add an
  `allowBuilds` entry to make an install succeed — see `managing-dependencies` for what
  each setting closes off. Each is a supply-chain decision, not a merge conflict.
