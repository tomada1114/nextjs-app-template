# Contributing

## Setup

Use Node.js 24 and pnpm 11 through Corepack:

```sh
node --version
corepack enable
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm check:quick
```

The first command must report Node 24.x. `devEngines.runtime.onFail` is an intentional
hard error, and nothing in this repository runs on another Node, so there is no occasion
to reach for the `--config.runtime-on-fail=ignore` override.

The install writes the Git hooks too, and nothing above has to ask for it: `lefthook`
ships its own `postinstall`, which `pnpm-workspace.yaml` allowlists, so every non-CI
`pnpm install` syncs the hooks `lefthook.yml` declares. That postinstall ignores the
exit status of the install it runs, though, so `package.json`'s `prepare` script then
runs `scripts/verify-hooks.mjs`, which installs nothing and fails the install unless a
lefthook pre-commit hook really sits at the path git will use. Installing the hooks is
therefore not a setup step of its own; `pnpm hooks:install` is the repair when the check
says one is needed.

The check itself skips, rather than fails, in two cases that are meaningless to verify:
`CI` set in the shell, and a `--prod` install, which never pulls `lefthook` into
`node_modules` at all. Beyond that, three things still leave a clone without the gate,
each of them deliberate or on screen: `pnpm install --ignore-scripts`, which runs
neither lifecycle script; setting `ALLOW_MISSING_GIT_HOOKS=1`, the documented opt-out
for a machine that genuinely cannot have a Git hook, which every failure message names;
and removing the hooks by hand after the install. `LEFTHOOK=0` is a fourth way, and not
an on-screen one — it leaves the hook installed and this check green while disabling the
gate at every commit; AGENTS.md's "Enforcement layers" explains why nothing here catches
it.

Useful focused commands are `pnpm check:source`, `pnpm test`, and `pnpm test:coverage`.

## Dependency cooldown

The seven-day dependency cooldown in `pnpm-workspace.yaml` is fail-closed. If an urgent
security fix is younger than seven days, a maintainer may add the exact package and
version to `minimumReleaseAgeExclude` in the same reviewed PR as the lockfile update.
Record the advisory and why waiting is riskier, remove the exception after the version
ages out, and never use a broad package-only or wildcard exclusion.

## Pull requests

Create a feature branch, keep commits focused, and use a Conventional Commit PR title.
Run `pnpm check:source` before requesting review.

Nothing here is published, so a change is not sized by a version number. What decides
whether a pull request also has to touch a test or a document is what the change is
observable as: behavior a caller outside the process can see needs its test updated in
the same pull request, and a rule that changed needs the file that owns that rule
changed with it. AGENTS.md says which surfaces are observable and which are private; the
`updating-docs` skill says when a change reaches `README.md` or this file.
