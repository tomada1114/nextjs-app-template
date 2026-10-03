# Security Policy

## Reporting a vulnerability

Never report a vulnerability in a public issue, a pull request, or a discussion. Open a
private advisory instead:

https://github.com/tomada1114/nextjs-app-template/security/advisories/new

That form is GitHub's private vulnerability reporting: only you and the repository's
maintainers can read the report. GitHub documents the flow in
[Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(checked 2026-10-01). The form only works while private vulnerability reporting is
enabled on the repository. If it is not available, open a public issue that asks for a
private contact channel and contains no detail of the vulnerability itself.

Include what a maintainer needs to reproduce and judge the problem:

- the affected file or files, and the commit you tested against;
- what an attacker can do, and under which preconditions;
- the smallest reproduction you have — a request, a command, or a test;
- a suggested fix, if you have one.

Never include a real credential, token, or someone else's personal data in a report. A
placeholder that shows the shape is enough.

## Response

Reports are handled on a best-effort basis by a single maintainer. There is no
guaranteed time to acknowledge, assess, or fix a report. A confirmed vulnerability is
fixed on `main` and disclosed through a GitHub security advisory, crediting the reporter
unless they ask not to be named.

This policy covers this template only. An application cut from it inherits this file
verbatim and replaces this section with its own commitments, and the reporting link
above with its own repository's.

## Supported versions

Only `main` is supported. Nothing here is packed, published, or released as a package,
so there is no older version to patch: a fix lands on `main` and nowhere else. An
application already cut from the template does not receive that fix automatically; it
has to port the change itself.

## Supply-chain posture

What this repository does today, and nothing more:

- **Actions pinned to commits.** Every `uses:` in `.github/workflows/` names a full
  40-character commit SHA annotated with its release tag, and `tests/workflows.test.ts`
  fails on a movable ref. Dependabot's `github-actions` updates move the SHA and the tag
  comment together.
- **A pinned package manager and a frozen lockfile.** `package.json`'s `packageManager`
  pins the exact pnpm version, and every CI install runs
  `pnpm install --frozen-lockfile`, so CI never resolves a version the lockfile does not
  already name.
- **A release-age cooldown.** `pnpm-workspace.yaml` refuses any dependency version
  published less than 7 days ago, including versions already in the lockfile, and fails
  closed when the registry reports no publish time. `.github/dependabot.yml` applies the
  same 7-day cooldown to version-update pull requests.
- **An install policy.** The same `pnpm-workspace.yaml` refuses a dependency whose
  provenance regressed against an earlier version, refuses transitive dependencies
  fetched from git or tarball URLs, and runs no lifecycle script outside a reviewed
  allowlist.
- **Dependency review on every pull request.** `dependency-review.yml` fails a pull
  request that introduces a dependency with a known advisory of moderate severity or
  above, or one under a denied copyleft license.
- **Credential scanning before merge and a weekly audit.** `security-audit.yml` runs a
  redacted full-history gitleaks scan on every pull request, including intermediate
  commits that later deleted a leaked key. The committed `main` ruleset requires that
  check. Scheduled and manual runs scan history too and run
  `pnpm audit --prod --audit-level=moderate`. The audit fails closed: an audit service
  it cannot reach is a red run, not a green one.
- **A pre-commit secret guard.** `lefthook`'s pre-commit hook runs
  `scripts/check-staged.mjs`, which refuses a staged `.env*` or `secrets/**` path and a
  credential in a staged file's content, including on the commit that concludes a
  conflicted merge. It runs on the committer's machine, so it is a guard rather than a
  guarantee: a commit made with hooks disabled never reaches it.

Some protections are repository settings rather than files, and "Use this template" does
not copy them. They apply only when enabled: secret scanning and push protection,
Dependabot alerts and security updates, private vulnerability reporting itself, and the
`main` ruleset that `pnpm repo:ruleset` applies from `.github/rulesets/main.json`.
AGENTS.md's "GitHub settings a new repository must enable" lists them and why each
matters.

## Patched dependencies

`braces@3.0.3`, reached through ESLint's Next.js plugin and `fast-glob`, has a local
pnpm patch for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
(CVE-2026-93687). No fixed release is published as of 2026-10-02. The patch follows
[upstream PR #72](https://github.com/micromatch/braces/pull/72) at commit
`d0d575e55e74a4e0218e5248fafb79efc3e54ebb`: parsing caps combined brace and parenthesis
nesting at 100, and the recursive compiler, expander and stringifier enforce the same
cap for caller-supplied ASTs. A caller may select a stricter cap, but cannot raise it.

`tests/braces-patch.test.ts` resolves the package that ESLint actually loads and checks
deep patterns, direct ASTs, the safe boundary and ordinary file globs. pnpm applies the
patch on every install; a missing or inapplicable patch fails the install or these
regression tests. The lockfile retains version `3.0.3`, so a version-based scanner can
still flag the advisory after the fix is applied. Replace the patched dependency with a
fixed upstream release once one satisfies the supply-chain policy.

The owner-approved exception in `osv-scanner.toml` suppresses only `GHSA-vfj7-8cjw-p6xm`
and its aliases until 2026-10-16. All other advisories remain enabled, and the exception
expires automatically. Remove the exception with the local patch when the fixed upstream
release can be installed.

## Responsible disclosure

This project follows coordinated disclosure: the details of a vulnerability become
public once a fix is available, or once the reporter and the maintainer agree they
should. In return for being taken seriously, three asks:

- Give the maintainer a reasonable time to fix a confirmed issue before you disclose it
  publicly, and say when you intend to.
- Test only against your own checkout or deployment. Do not access, modify, or delete
  data that is not yours beyond the minimum needed to demonstrate the issue.
- Do not degrade anyone's service: no denial-of-service testing, no spam, and no social
  engineering of maintainers or users.
