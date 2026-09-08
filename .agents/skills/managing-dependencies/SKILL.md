---
name: managing-dependencies
description: >
  Covers whether a package may be added to this repository and what happens at install
  time: the review record a PR adding a runtime dependency must carry, how a dependency
  change is verified before it lands, SemVer range versus exact pin, the
  minimumReleaseAge cooldown and its exception process, the supply-chain settings in
  pnpm-workspace.yaml and its allowBuilds allowlist, and the typescript version ceiling.
  Use when adding or bumping a dependency, editing package.json's dependencies, an
  install fails on a peer range or a lifecycle script, or someone proposes raising
  typescript.
---

# Managing Dependencies

**Owns:** whether a package may exist in this repository at all, and what happens at
install time. **Does not own:** landing an existing bot PR (`merge-dependabot`).

This repository is a private application. Nothing here is packed, published, or consumed
as a tarball, so a dependency is judged by what it costs to install and to run — never
by what it would do to a published surface.

## The review record a new runtime dependency needs

Adding a runtime dependency is a permanent supply-chain commitment, so before adding
one, record all of the following in the PR that adds it. Missing one item is not a
detail to fill in later — it means the review has not actually happened yet.

- Why a small hand-written helper or a Node builtin cannot replace it. `node:util`'s
  `parseArgs` covers subcommands (`allowPositionals`) and rejects unknown flags
  (`strict`), so an argument-parser dependency needs a reason beyond convenience.
- Maintainer and release continuity — actively maintained, not abandoned.
- License compatibility. `.github/workflows/dependency-review.yml` denies a copyleft
  license outright, so a package under one does not merge; find another.
- Direct and transitive package count it pulls in — a large transitive surface is a real
  cost even behind a small direct API.
- Whether it runs an install script, ships a native binary, or does network access —
  each needs its own justification, and an install script also needs a ruling in
  `allowBuilds` (see below).
- Supported Node versions and module format (ESM/CJS) against this repository's own
  `devEngines.runtime` and `"type": "module"` in `package.json`.
- Open security advisories and npm provenance.
- Which of `dependencies`, `devDependencies`, or `optionalDependencies` it belongs in,
  and why. There is no fourth option: this repository publishes nothing, so it declares
  no `peerDependencies` of its own. Every peer range you will meet was declared by
  something you installed.

A runtime entry is the expensive one: `dependencies` is what ships to the running
application and what the weekly `security-audit.yml` job audits with
`pnpm audit --prod`. A build- or test-only package belongs in `devDependencies`, where
an advisory is handled by a bot PR instead of paging whoever reads that schedule.

## Verifying a dependency change before it lands

A manifest and lockfile change is verified by a real install and a real run, never by a
test that mocks a package manager at its subprocess boundary. Run, in order:

```bash
pnpm install            # regenerates pnpm-lock.yaml; must succeed under the policy below
pnpm check:quick        # format, lint, typecheck, tests
pnpm build              # next build — the App Router entry points and the framework's
                        # own build pipeline, which no unit test exercises
pnpm test:coverage      # the coverage floors, which a swapped dependency can move
```

The last three are together what `pnpm check:source` runs, so one green run of that
covers them all. One narrower run is worth naming, because the gate reports its failure
only as a wall of output: the suite for the module that actually consumes the bumped
package, run on its own.

```bash
pnpm exec vitest run tests/<module>.test.ts
```

A `zod` bump surfaces first in whichever contract suite parses with it; a `react` bump
in the component tests. Every suite here runs against a fake rather than a live service,
so there is no record or replay command to reach for — do not invent one until a suite
that needs it exists.

Two checks run only on the PR. The `Dependency review` workflow fails on a new advisory
or a denied license, and the weekly production audit above is now a gate that can
actually fail: with runtime `dependencies` no longer empty, `pnpm audit --prod` is no
longer the no-op it was, so a red one is a finding about a package this application
ships, not noise.

## Range vs. pin, and how a change lands

- A runtime dependency declares a SemVer **range**, never an exact pin — a range plus
  `pnpm-lock.yaml` reproduces the install, and a pin only removes the fallback that
  makes the cooldown below survivable.
- Add or bump through `pnpm add`, never by hand-writing a version into `package.json`. A
  hand-typed recent version can be younger than the cooldown below, and a pin has no
  older version to fall back to, so the install fails outright rather than resolving to
  something older.
- A dependency change and its `pnpm-lock.yaml` update belong in the same commit. The
  lockfile is generated by `pnpm install`, never hand-edited: a hand-written entry
  states an integrity hash and a resolved graph nobody verified against the registry,
  and nothing downstream can tell that apart from a real resolution. Regenerate instead,
  with `pnpm install --lockfile-only` when you want the lockfile without the install.
- Dev dependencies are kept current by bot PRs plus the lockfile, not by hand.
  **REQUIRED:** `merge-dependabot` to land one.

## The release-age cooldown

`pnpm-workspace.yaml` sets a `minimumReleaseAge` cooldown: a version published too
recently will not resolve, for any install. Treat this as behavior to design around, not
an obstacle to route past.

- A `^`/`~` range silently resolves to an older, already-cooled version instead of the
  newest matching one — this is expected, not a bug.
- An exact pin on a version younger than the cooldown fails the install outright, since
  there is no older matching version for a pin to fall back to.
- Before adding or bumping a dependency, check how long its target version has actually
  been published; do not assume `latest` will resolve.

### Exception process

For an urgent security fix younger than the cooldown, a human may approve an exact
`package@version` entry in `minimumReleaseAgeExclude`. The same PR must:

- cite the advisory,
- explain why waiting is riskier than skipping the cooldown,
- include the regenerated lockfile, and
- state when the exception will be removed.

Never add a wildcard entry or a package-only (unversioned) exclusion — the exception is
scoped to one exact version, not to the package forever.

## Supply-chain settings, as consequences

`pnpm-workspace.yaml` holds the values; this is what each one means when it fires. Read
the file for the current values rather than trusting a number copied here.

- `strictDepBuilds` plus `allowBuilds`: an install-time lifecycle script from a
  dependency nobody has ruled on fails the install **on purpose** — that is the intended
  outcome, not a bug to route around. A Next.js dependency tree reaches several packages
  that want to run one, so this is a case-by-case review now rather than a single
  standing exception. Three questions settle an entry: what the script actually does
  (download a binary, compile native code, probe for a prebuilt one); whether anything
  this repository runs needs its result, or it belongs to a feature never turned on; and
  whether the package already ships a prebuilt platform binary as an optional
  dependency, making the script a fallback rather than the only path. `false` is as much
  a decision as `true` — it records that the script was reviewed and refused, so the
  next install failure is not answered with a reflexive `true`. Read the file's comments
  for the ruling each entry carries; adding a `true` one carries the same review weight
  as adding a new dependency.
- `strictPeerDependencies`: a peer range declared by an installed dependency and left
  unmet or conflicting is a hard install failure, not a warning. This is what makes the
  TypeScript ceiling below an enforced constraint instead of an advisory one. The only
  sanctioned way past it is a `peerDependencyRules.allowedVersions` entry naming one
  `parent>child` edge, and adding one asserts the package really does work against the
  version it did not declare — it is not a way to quiet an inconvenient failure.
  `overrides` is the same shape of exception for a resolved version, with the same
  burden: name the single edge, say why, and say what would let it be dropped.
- `minimumReleaseAgeStrict` and `minimumReleaseAgeIgnoreMissingTime` close two specific
  bypasses of the cooldown above: an already-lockfiled version skipping the check, and
  registry metadata with no publish time being treated as old enough, respectively.
- `trustPolicy`, `trustLockfile`, and `blockExoticSubdeps` are independent supply-chain
  protections, not part of the cooldown: they reject a provenance/trusted-publisher
  regression, refuse to trust the trust metadata recorded in a contributor's lockfile,
  and refuse transitive dependencies fetched from git or arbitrary tarball URLs,
  respectively.
- `verifyDepsBeforeRun: error`: a `pnpm run` whose `node_modules` no longer matches the
  lockfile fails instead of letting a gate pass against stale dependencies. The fix is
  `pnpm install`, never a weaker value.
- `pmOnFail: download`: a local pnpm that does not satisfy `devEngines.packageManager`
  makes the install fetch the pinned one rather than fail. It is the only convenience
  here rather than a gate — it changes which pnpm resolves the lockfile, never what the
  policy above admits.

When one of these fires, find out why the install is actually failing; AGENTS.md holds
the prohibition on relaxing it.

## TypeScript version ceiling

`typescript` is held below the version `typescript-eslint` caps its peer support at.
That package is now the only thing setting this ceiling, and it caps at a **minor**, not
just below the next major, so read the real range instead of assuming:

```bash
node -p "require('typescript-eslint/package.json').peerDependencies.typescript"
```

Compare it to `package.json`'s `devDependencies` range. With `strictPeerDependencies`
on, a bump past the ceiling fails the install rather than merely warning, and
`.github/dependabot.yml` keeps a `typescript` major from arriving as a PR at all.

Do not "upgrade typescript to latest." Raising this ceiling is a coordinated upgrade —
`typescript-eslint` has to raise its own peer range first — not a routine bump.

## Handoff

**REQUIRED:** `merge-dependabot` for landing an already-open bot PR against these rules.
