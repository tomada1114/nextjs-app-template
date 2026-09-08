---
name: changing-gates
description: >
  Covers editing a file that enforces rather than implements: a .github/workflows/*.yml
  CI workflow, lefthook.yml, or a setting inside eslint.config.mjs, tsconfig.json,
  vitest.config.ts, .prettierrc.json, or next.config.ts. Use when a CI job or a deploy
  workflow is proposed, a step is added to check:source or ci.yml, a lefthook stage or
  glob changes, an ESLint rule or a vitest project is added or loosened, or the question
  is which gate would have caught a change — including what none of them sees, such as
  src/proxy.ts and anything needing a running server.
---

# Changing Gates

**Owns:** a change to a file that enforces rather than implements — a CI workflow,
`lefthook.yml`, or a tool config (`eslint.config.mjs`, `tsconfig.json`,
`vitest.config.ts`, `.prettierrc.json`, `next.config.ts`) — and which gate can see a
given change at all. **Does not own:** adding a dependency the config then configures
(`managing-dependencies`); a coverage floor's value or which vitest project a test joins
(`placing-tests`); a `.mjs` under `scripts/` that a gate invokes
(`writing-repo-scripts`); what `src/proxy.ts` does and where it belongs
(`building-app-routes`); `.github/labels.yml` (`triaging-issues`).

## The one rule every gate change shares

A gate file may narrow _what_ a tool looks at; it may never define a rule of its own.
`lefthook.yml`'s header states this for the hook layer, and it is equally true of CI,
which runs the same package scripts as separate steps. Adding a check therefore means
adding a package script and calling it from the gate, never inlining a command into a
workflow step or a hook line.

## `check:source` and `ci.yml` are one list written twice

`package.json`'s `check:source` composes as one script the same ground
`.github/workflows/ci.yml` covers as separate `run:` steps — split there so a reader
sees which step failed rather than only that the composite did. `tests/ci-sync.test.ts`
holds the two together, both ways: it extracts every `pnpm run <name>` token out of
`check:source` and out of every job `ci.yml` declares — the job list is parsed from the
file rather than named in the test, so a third job counts the day it lands — and fails
when a step on either side has no counterpart on the other.

The exceptions are two maps, one per direction, each value a stated reason rather than a
comment: `CHECK_SOURCE_ONLY_EXCEPTIONS`, empty today, and `CI_ONLY_EXCEPTIONS`, which
holds `test`. That one is ci.yml's `Run tests without coverage` step, the
`matrix.os != 'ubuntu-latest'` branch that keeps coverage collected exactly once should
a second OS join the matrix; `check:source` runs `test:coverage`, the same suite plus
the coverage floors, so a local run is not missing a gate. Adding an entry to either map
is a claim to argue in the PR, and a stale one fails the suite — each key has to still
name a real step on its own side.

A new gate is therefore three edits, not one: the package script, the `check:source`
composition, and the matching `ci.yml` step — and the suite now fails if either of the
last two is skipped, whichever way round. What it does not judge is _which_ job a CI
step lands in: steps are collected across all jobs, so a check that belongs in `static`
but sits in `test` satisfies both directions. That one is still read by a human.

## CI workflows

`tests/workflows.test.ts`'s `lintWorkflow` is the mechanical half, and it is cheaper to
read before writing a workflow than after the run goes red. It rejects, each with its
own `ERR_WORKFLOW_*` code:

- `pull_request_target` anywhere — it runs fork code with a writable token.
- an action not pinned to a 40-character commit SHA, or pinned with no trailing
  `# vX.Y.Z` comment saying which release that SHA is. A local `./…` action is exempt,
  having no SHA to pin.
- a missing top-level `permissions`, or one wider than `{}` or `contents: read`.
- a job that declares no `permissions` of its own, or grants `write-all`.
- a workflow that declares no jobs at all, and a job whose steps the scanner cannot
  reach — every step rule reads the same step list, so a job it cannot read is a hole in
  all of them at once and is reported rather than passed. A job that calls a reusable
  workflow through its own `uses:` is exempt, having no steps to find.
- a job with no `timeout-minutes`. A step-level timeout does not substitute.
- an `actions/checkout` step without `persist-credentials: false`.
- `actions/setup-node` ordered before `pnpm/action-setup`, whose failure mode is a
  silently empty store cache rather than an error.
- a `pull_request` workflow with no `concurrency`; and, on a workflow that also runs on
  `push`, an unconditional `cancel-in-progress` — killing a push run destroys the only
  CI record a merged commit gets.
- a multi-line `run:` that neither opens with `set -euo pipefail` nor runs under a
  fail-closed `defaults.run.shell`. `shell: bash` is not enough: it leaves `-u` off.
- a `pnpm … install` without `--frozen-lockfile`, which would make every other gate
  advisory.

Reading each of those blocks is `blockOf`, and indentation is not all it goes on: YAML
lets a block sequence start in the same column as the key it belongs to, so a key
awaiting a block value claims same-column `- ` entries as well as more deeply indented
ones. That is what keeps `steps:` written at its own column from reading as a job with
no steps, and it is why a fix for one such blind spot belongs in `blockOf` rather than
in the caller that noticed it.

Those rules hold for **every** workflow this repository ever gains, a deploy workflow
included: the suite runs `lintWorkflow` over whatever `.github/workflows/` contains. Two
lists in that file are exact and only a human edits them.

- The filename list in "includes every workflow spec 02 §5.2 makes mandatory" is
  compared with `toEqual`, so a new workflow file fails the suite until it is added
  there. That failure is the review prompt, not an obstacle to route around.
- The writers list in "grants a write scope only where the job cannot do its work
  without one" is `["pr-label.yml"]` today. A workflow carrying any `: write` scope has
  to join it — a deploy workflow that pushes, tags, or comments included.

The judgment half no test encodes:

- A new workflow file is warranted only when the work does not belong as a job inside
  `ci.yml` — a different trigger shape or a genuinely separate permission footprint, not
  a convenience split.
- Widening write access, or adding a second workflow that writes, is a security-relevant
  change and needs the weight of review a new write grant deserves, not a routine CI
  edit.
- A PR that deletes or narrows a security-relevant step (the pin, the `permissions`
  block, `persist-credentials: false`, a timeout) must say in its own body why the
  removed protection no longer applies here. Silence is not review for that.

## `lefthook.yml`

The hook is deliberately narrow, and AGENTS.md's "Enforcement layers" holds the argument
for why. The bar for a new or changed job follows from it: it must never fire on
intended work — test it against a normal commit before trusting it to catch a bad one.

Job ordering is load-bearing rather than incidental. `format` runs alone before the
parallel group so `eslint`, `typecheck` and `check:staged` see the formatted, re-staged
blobs rather than the working tree as it stood before the commit began. Preserve that
shape across an edit instead of parallelizing it away. A job that inspects file
_content_ — `check:staged` today — must stay in the group that runs after `format`.

Two jobs carry no `glob` on purpose: `check:staged` has to see every staged path
whatever its extension, and `test:related` has to see the paths themselves to work out
what is related, including a staged test file with no production counterpart. Adding a
glob to either narrows it in a way nothing reports. When a new extension enters the tree
(`.tsx` did), the globbed jobs are the ones to revisit.

## What `check:staged` actually covers

`scripts/check-staged.mjs` inspects the git index: for each staged change it classifies
the **path** through `scripts/lib/guard/paths.mjs`'s `checkRead` (the `.env*`,
`secrets/**`, and `.claude/settings.local.json` shapes) and, when the path passes, the
staged **blob content** through `scripts/lib/guard/credentials.mjs`'s
`checkCredentials`. That is the whole of its scope. It judges nothing about whether a
commit weakens a gate — that is the pull request's job.

Two properties are worth knowing before relying on it or editing it:

- It rejects a file on its **basename alone** when the name looks like a private key —
  `KEY_FILE_SUFFIXES` and `KEY_FILE_BASENAMES` in `check-staged.mjs`, matched
  case-insensitively — because such a file may be binary or encrypted and so cannot be
  relied on to trip the content patterns. That rule lives in `check-staged.mjs` itself,
  **not** under `scripts/lib/guard/**`, so it sits under the broader `scripts/**`
  coverage floor rather than the stricter guard floor. A change to it needs its test
  written deliberately; the aggregate floor will not ask for one.
- `checkStagedChange` returns `null` for `change.status === "D"`. **A staged deletion is
  never inspected** — deleting a secret-shaped file, a workflow, or a test passes this
  layer untouched, by design. Nothing else in the repository watches for it either.

## Tool configs

Each of `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc.json` and
`next.config.ts` holds its own current values — read the file rather than a copy of a
rule written elsewhere. A PR changing one owes three things in its body: which rule or
option moved, why, and what now passes or newly fails that did not before. AGENTS.md
governs whether the change is allowed at all; this skill does not restate that.

Traps that have cost time here:

- In `eslint.config.mjs`, `no-restricted-syntax` and `no-restricted-imports` **replace**
  their options across config objects rather than merging. A narrower block that sets
  either rule silently switches off every entry it does not restate — which is why
  `NO_ENUM` and `NO_EXPORT_STAR` are shared constants and why the `boundaries/*` blocks
  match disjoint file sets. Keep a new block disjoint from them, or restate what it
  still wants.
- `eslintConfigPrettier` must stay the last element of the exported array. Anywhere else
  it stops turning off the stylistic rules that would fight Prettier, and the two gates
  then disagree about the same file.
- `eslint-config-next` states its rule blocks against `**/*`; this config re-scopes each
  to the `src/` tree on the way in. Spreading a new shared config in unscoped puts
  framework rules on `scripts/**` and `tests/**`.
- The named blocks are the map: `src/shared-syntax`, `src/size-budget`,
  `public-api/explicit-surface`, `boundaries/core-is-framework-free`,
  `boundaries/adapters-are-reached-through-src-ai`,
  `boundaries/port-does-not-know-its-adapters`,
  `boundaries/private-trees-are-not-importable`, `automation/node-scripts`,
  `tests/vitest-rules`, `tests/relaxations`. Name a new block the same way — the name is
  what a reader, and ESLint's own config inspector, has to identify it by.
- `vitest.config.ts` runs three projects — `unit`, `component` (jsdom), `automation` —
  and coverage is collected once for the whole run, never per project. Which project a
  file joins, and the value of any threshold, are `placing-tests`. What belongs here is
  that `extends: true` is what carries the shared `allowOnly`/restore/unstub settings
  into a project: a hand-written project object without it drops them silently.
- `next.config.ts` is a gate as well as a build config: `agentRules: false` is what
  stops `next dev` appending to AGENTS.md behind the author. Removing it makes a
  hand-written source of truth a tool rewrites.

## What no gate here sees

No check in this repository boots a server or a browser. `pnpm build` type-checks the
App Router entry points and compiles them; nothing loads a request path. The consequence
worth planning around before adding a gate: a change can be wrong in a way every gate
passes — the `src/proxy.ts` location trap is the worked example, and
`building-app-routes` owns it. A gate proposed to close that class of gap is a real
gate, not a lint rule, and belongs in the PR as such.
