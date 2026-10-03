# Supply-chain settings

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
  TypeScript ceiling in the main skill an enforced constraint instead of an advisory
  one. The only sanctioned way past it is a `peerDependencyRules.allowedVersions` entry
  naming one `parent>child` edge, and adding one asserts the package really does work
  against the version it did not declare — it is not a way to quiet an inconvenient
  failure. `overrides` is the same shape of exception for a resolved version, with the
  same burden: prefer naming the single `parent>child` edge, say why, and say what would
  let it be dropped. A package-wide override is the exception to that, and needs its own
  reason in the comment — that several independent edges reach the bad version, so an
  edge list would be incomplete the moment a new transitive dependency reopens it.
- `minimumReleaseAgeStrict` and `minimumReleaseAgeIgnoreMissingTime` close two specific
  bypasses of the release-age cooldown in the main skill: an already-lockfiled version
  skipping the check, and registry metadata with no publish time being treated as old
  enough, respectively.
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
  policy in the main skill admits.

When one of these fires, find out why the install is actually failing; AGENTS.md holds
the prohibition on relaxing it.
