# Contributing

## Setup

Use Node.js 24 and pnpm 11 through Corepack:

```sh
node --version
corepack enable
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check:quick
```

The first command must report Node 24.x. `devEngines.runtime.onFail` is an intentional
hard error, and nothing in this repository runs on another Node, so there is no occasion
to reach for the `--config.runtime-on-fail=ignore` override.

Useful focused commands are `pnpm check:source`, `pnpm test`, and `pnpm test:coverage`.

## Dependency cooldown

The seven-day dependency cooldown in `pnpm-workspace.yaml` is fail-closed. If an urgent
security fix is younger than seven days, a maintainer may add the exact package and
version to `minimumReleaseAgeExclude` in the same reviewed PR as the lockfile update.
Record the advisory and why waiting is riskier, remove the exception after the version
ages out, and never use a broad package-only or wildcard exclusion.

## Pull requests

Create a feature branch, keep commits focused, and use a Conventional Commit PR title.
Update behavior tests, type tests, and documentation when the public contract changes.
Run `pnpm check:source` before requesting review.

Every pull request explains what it changes and keeps the README, tests, and
documentation in sync when it does.
