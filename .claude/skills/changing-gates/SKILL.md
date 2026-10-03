---
name: changing-gates
description: >
  Covers editing a file that enforces rather than implements: a .github/workflows/*.yml
  CI workflow, lefthook.yml, or a setting inside eslint.config.mjs, tsconfig.json,
  vitest.config.ts, .prettierrc.json, or next.config.ts. Use when a CI job or a deploy
  workflow is proposed, a step is added to check:source or ci.yml, a lefthook stage or
  glob changes, an ESLint rule or a vitest project is added or loosened, or the question
  is which gate would have caught a change - including what none of them sees, such as
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

## Gate files

Follow [the per-file guide](references/gate-files.md) when editing a workflow,
`lefthook.yml`, the staged guard, or a tool config. It holds the specific traps and
review obligations. Use [the weakening guide](references/weakening.md) to assess what
protection an edit removes and what its review must explain.

## What no gate here sees

No check here boots a browser, and only one boots a server: `pnpm run test:smoke` serves
the last `pnpm build` with `next start` under `NODE_ENV=production` and asserts over
`fetch` that `/` redirects to a locale-prefixed path, that `/en` and `/ja` render with
the right `<html lang>`, that an unknown unprefixed path is redirected rather than 404ed
and that the prefixed one 404s, that the page links a stylesheet carrying a Tailwind
utility it uses, and that `POST /api/ask` answers its documented statuses. The
stylesheet case is the only check that sees PostCSS run at all: a component test renders
a `className` into the DOM whether or not any CSS was generated. Each hop is asserted
with `redirect: "manual"`, because a followed redirect merges the proxy's answer with
the route's and would pass with the proxy gone. That is the whole of what a running
server is checked for — the seams between the layers, not their behaviour, which each
layer's own suite owns.

It runs from `check:source` and from ci.yml's `static` job, both times immediately after
`Build`, and from neither `pnpm test` nor `pnpm check:quick`: the build is what it
serves, so a run without one would either fail or pay for a second build. It never
builds for itself — it compares `.next/BUILD_ID` against `src/`, `messages/`,
`next.config.ts` and `postcss.config.mjs` and refuses a missing or stale build, which is
how the caller stays the only one paying for a build. A green `check:quick` therefore
still says nothing about anything only a running server shows.

Everything outside those five assertions is still a place a change can be wrong while
every gate passes. A gate proposed to close such a gap is a real gate, not a lint rule,
and belongs in the PR as such.
