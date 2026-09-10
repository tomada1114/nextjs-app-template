# Project Guide

This file is the source of truth for every agent working in this repository.
Tool-specific files (`CLAUDE.md` and anything like it) add only what is specific to that
tool; they never restate what is here.

Machine-enforceable rules are not written down here either. `eslint.config.mjs`,
`tsconfig.json`, `.prettierrc.json`, `vitest.config.ts` and `pnpm-workspace.yaml` are
the source of truth for those, and running the gate is how you learn them.

Neither are the conventions of a particular kind of work. Those live in the skills under
`.agents/skills/`, one per kind of change, and load when the work you are doing calls
for them — see [Skills](#skills) for the index. What is left in this file is what has to
be true _before_ you know which task you are on: what this package is, how to check a
change, and which decisions need a human.

**Never hand-edit `.claude/skills/`** — it is a generated mirror, and a change there is
lost at the next sync. `authoring-skills` owns how a skill is authored, mirrored, and
checked.

## Overview

A template for a Next.js application on the App Router, written in ESM-only TypeScript:
a locale-prefixed page tree, one JSON endpoint, and one language-model call behind a
port that an adapter implements. It answers with a fake adapter out of the box, so
`pnpm dev` works before any credential exists, and the whole AI layer is built to come
out in one piece for a project that does not want one.

It is private: nothing here is packed, published, or consumed as a tarball, so there is
no published `engines.node` floor — `.node-version` and `devEngines.runtime` carry the
Node 24 development runtime instead. pnpm 11 is the package manager, used through
Corepack.

## Quick reference

```sh
pnpm dev           # start the Next.js development server on http://localhost:3000
pnpm build         # production build; also type-checks the App Router entry points
pnpm start         # serve the production build from `pnpm build`
pnpm check:quick   # format check, lint, typecheck, tests — the everyday gate
pnpm check:source  # the same gate plus the build, with coverage thresholds enforced
pnpm fix           # ESLint autofix, then Prettier
pnpm test          # tests only
pnpm test:coverage # tests with the coverage thresholds enforced
pnpm test:smoke    # serves the last `pnpm build` with `next start` and asserts over HTTP
pnpm agents:sync   # regenerate .claude/skills/ from .agents/skills/
pnpm agents:check  # fail when the two skill trees have drifted apart
pnpm repo:labels   # create/update GitHub labels from .github/labels.yml
pnpm hooks:install # repair the Git hooks; `pnpm install` installs them already
pnpm clean         # remove the build and tool caches (.next, coverage, .eslintcache, tsbuildinfo)
pnpm clean:deep    # the same, plus dist/ and node_modules/ — a reinstall follows
```

Reach for `pnpm clean`/`pnpm clean:deep` rather than an `rm -rf`: `scripts/clean.mjs`
refuses any path that resolves outside this repository, symlinks followed, so neither a
typo nor a directory link leading out of the checkout can reach the machine, and the
target list is reviewable in `package.json` instead of retyped at a prompt each time.
`clean:deep` leaves the checkout without dependencies — run `pnpm install` after it.

Run a single test file with `pnpm exec vitest run tests/<name>.test.ts`.

`pnpm check:quick` is the everyday local gate; `pnpm check:source` adds the build and
the coverage floors on top of it. CI runs those same checks as separate steps, so a
green `pnpm check:source` here means those are green too. `lefthook`'s pre-commit hook
runs a staged-file-scoped version of the same tools — format applied rather than merely
checked, tests limited to the ones reachable from the staged files — before every
commit. Nothing — not a hook, not a workflow — defines a check of its own; they all call
these scripts.

Development and source checks stay on Node 24, stated once in `.node-version` and once
in `devEngines.runtime`. Never relax `devEngines.runtime`'s `onFail: error`, and never
reach for `--config.runtime-on-fail=ignore`: nothing here runs on any other Node.

## Validating a change

Run the narrowest check that can fail, then the gate. Reaching for `pnpm check:source`
on every edit is slow enough that it stops being run at all.

| What you changed                                       | The narrowest check that can fail                    |
| ------------------------------------------------------ | ---------------------------------------------------- |
| A module under `src/core/` or `src/ai/`                | `pnpm exec vitest run tests/<module>.test.ts`        |
| A handler or the composition root under `src/server/`  | `pnpm exec vitest run tests/server-handler.test.ts`  |
| `src/server/env.ts` or `.env.example`                  | `pnpm exec vitest run tests/server-env.test.ts`      |
| A page, layout or route handler under `src/app/`       | `pnpm build`, then `pnpm test:smoke`                 |
| A component with a rendered test                       | `pnpm exec vitest run tests/<name>.test.tsx`         |
| A catalog under `messages/`, or `src/i18n/messages.ts` | `pnpm exec vitest run tests/messages.test.ts`        |
| `src/proxy.ts` or the locale routing behind it         | `pnpm exec vitest run tests/proxy.test.ts`           |
| Anything only a running server shows                   | `pnpm build`, then `pnpm test:smoke`                 |
| An import that crosses a zone boundary                 | `pnpm exec vitest run tests/boundaries.test.ts`      |
| A test                                                 | `pnpm exec vitest run tests/<name>.test.ts`          |
| A script under `scripts/`                              | `pnpm exec vitest run tests/<script>.test.ts`        |
| A skill under `.agents/skills/`                        | `pnpm agents:sync && pnpm agents:check && pnpm test` |
| `package.json`, `pnpm-workspace.yaml`                  | `pnpm install`, then `pnpm check:source`             |
| Markdown                                               | `pnpm fix`                                           |

## Architecture

```
src/
├── core/     # framework-free vocabulary: a Result, a domain type, a pure function
├── ai/       # the LlmPort, its error vocabulary, and the adapters behind it
├── server/   # the environment read, the composition root, and request handlers
├── i18n/     # the locale list, its URL routing, and the typed message catalogs
├── app/      # the Next.js App Router tree: pages, layouts, route handlers
└── proxy.ts  # Next.js's request proxy: locale detection ahead of every page request
messages/     # one JSON catalog per locale, shaped by en.json
scripts/      # repository automation, authored as .mjs, never shipped
```

Imports run one way — `app` → `server` → `ai` → `core` — with `i18n` a leaf that the
page tree and the handlers both read. `core` is the bottom of that order: it names no
framework and no vendor SDK, so it survives a change of either.

### The three seams

Everything a project built from this template is expected to replace sits behind one of
three seams:

- **The port.** `src/ai/port.ts` declares `LlmPort`, the vendor-neutral interface every
  model call goes through, and `src/ai/index.ts` is the AI layer's whole surface — the
  port, its error vocabulary, and whichever adapter that file chooses to publish.
  `src/ai/adapters/` is private to the layer, so swapping the fake for a provider, or
  deleting the layer outright, is a bounded edit; `tests/ai-layer-removal.test.ts` is
  what keeps the deletion bounded rather than trusting that it stays so.
- **The Web-standard handler.** `src/server/handlers/ask.ts` exports
  `createAskHandler(dependencies)`, which returns a plain
  `(request: Request) => Promise<Response>` and imports nothing from `next`. That is
  what lets a test drive it with `new Request(…)` and no framework, and what keeps
  `src/app/api/ask/route.ts` a one-line re-export with no logic of its own to test.
- **The environment.** `src/server/env.ts` is the only module under `src/` that reads
  `process.env`. It validates the whole environment against one schema and hands every
  other module what it needs as an argument, so "where does this secret enter the
  process" is a question a reader answers by opening one file.

`src/server/composition.ts` is where the three meet: the single place the environment,
an adapter and a handler are joined, and the single line in this repository that names a
vendor. That choice made anywhere else is the leak these boundaries exist to prevent.

### Rate limiting

This template deliberately implements neither rate limiting nor concurrency limiting for
`POST /api/ask`. It owns no limiter state, store, algorithm, or rate-limit environment
variable. A deployment that wires a billed adapter must enforce its caller-throughput
policy at an edge or gateway before the request reaches the app, with enforcement shared
across instances; a per-process limiter is not equivalent across instances.
`API_ACCESS_KEY` is authentication only, not a rate-limit declaration.

The app still owns its existing per-request request-body and prompt ceilings and rejects
those before `llm.generate`.

### What is contract and what is private

Nothing here is published, so the contract is not an export map. It is what a caller
outside the process can observe, plus what each zone publishes to the zone above it:

- **Contract.** The HTTP surface of `POST /api/ask` — its request body, its answer, and
  the `error.code` vocabulary a client branches on. The `LlmPort` interface, `LlmError`
  and its `ERR_LLM_*` codes, and everything else `src/ai/index.ts` names. The locale
  list in `src/i18n/locales.ts` and the message keys `messages/en.json` defines.
- **Private.** `src/ai/adapters/**`; the wiring inside `src/server/composition.ts`; and
  any module a zone's own surface does not re-export. A test reaches a private module
  through the surface that owns it, never around it.

Next.js loads a page, layout, boundary or route handler under `src/app/` by file name
through its default export, and does the same for `src/proxy.ts` and
`src/i18n/request.ts`. Those are framework-owned entry points, where the file's path is
the symbol's name; everywhere else under `src/` the surface is named exports, which is
what a reviewer can read a diff of.

These edges are enforced twice and their values are written down in neither this file
nor a skill: `eslint.config.mjs` carries them as `no-restricted-imports` zone blocks and
a per-file size budget, and `tests/boundaries.test.ts` asserts the same edges from the
module graph, so a rule deleted from that config still fails the suite. Read the numbers
and the patterns there — a summary that restated them is the copy that goes stale. How
to work inside a zone is a skill's subject, not this section's.

## Skills

Each skill owns one kind of change. Load the one whose subject you are working on; each
names its own boundary with its neighbours.

| Skill                   | Load it when you are working on                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `building-app-routes`   | a page, layout or Route Handler under `src/app/`, `src/proxy.ts`, or `src/server/`                                                  |
| `localizing-ui`         | a catalog under `messages/`, a module under `src/i18n/`, or adding a UI string                                                      |
| `integrating-llm`       | the `LlmPort`, an adapter under `src/ai/`, or a fixture under `tests/fixtures/llm/`                                                 |
| `writing-typescript`    | a `.ts` module or a `.tsx` component under `src/`                                                                                   |
| `designing-errors`      | an error type or an `ERR_*` code, in `src/` or `scripts/`                                                                           |
| `writing-tests`         | the body of a test under `tests/`                                                                                                   |
| `placing-tests`         | a new test file, a vitest project, or a coverage floor                                                                              |
| `type-testing`          | an `expectTypeOf` assertion or a `@ts-expect-error` inside a test                                                                   |
| `writing-repo-scripts`  | a `.mjs` under `scripts/`                                                                                                           |
| `authoring-skills`      | a skill under `.agents/skills/`                                                                                                     |
| `changing-gates`        | a CI workflow, `lefthook.yml`, or a tool config                                                                                     |
| `managing-dependencies` | adding, bumping, or removing a package by hand, or pinning `.mcp.json`'s MCP server versions (an open bot PR is `merge-dependabot`) |
| `merge-dependabot`      | landing open Dependabot or Renovate pull requests                                                                                   |
| `updating-docs`         | `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, or whether a change owes a doc at all                                                  |
| `triaging-issues`       | filing, labelling, or ranking a GitHub issue                                                                                        |
| `starting-an-app`       | turning this template into a new app: the rename, the AI layer, the locales                                                         |

## Security and human approval

- **Commit, push, and pull request always need a human.** No file this repository ships
  blocks the dangerous spellings — `--no-verify`, a plain force-push, workflow dispatch
  — mechanically; this instruction is the rule itself, not a pattern enforcing it. The
  committed `.claude/settings.json` declares only plugins, and `.mcp.json` only MCP
  servers; an agent may still carry its own personal permission allow/deny list on top
  (a Claude Code session's own `~/.claude/settings.json` or the gitignored
  `.claude/settings.local.json`), but that list is a choice made outside this
  repository, not something it ships or requires.
- Never read or write `.env*` (the `.example`, `.sample` and `.template` variants are
  fine), anything under `secrets/`, or `.claude/settings.local.json`. A `.env` in a
  checkout of this template holds a real provider credential, so reading one is already
  a disclosure whether or not anything is written back: no `cat`, no `grep`, no copy to
  a temp path, and never a value out of it onto a command line. `src/server/env.ts` is
  the list of names the process reads, and `.env.example` ships every one of them with
  an empty value — those two are what to open when you need to know what exists.
- Never write a credential into a tracked file — no registry auth token, no private key.
- `pnpm-lock.yaml` is generated by `pnpm install`, never hand-edited;
  `managing-dependencies` holds the reasoning.
- Never weaken a gate to make a run pass: no lowered coverage threshold in
  `vitest.config.ts`, no file added to `coverage.exclude` to move a number, no deleted
  security workflow, no removed `--frozen-lockfile`, no removed or relaxed ESLint rule
  or `pnpm-workspace.yaml` supply-chain setting, no `@ts-ignore`, no blanket
  `eslint-disable`, no skipped or deleted test. If a gate is wrong, say so and let a
  human decide.

That last rule stays here rather than moving into a skill, because the agent it has to
reach is looking at a red run and has classified its task as "make CI green" — not as
writing a test or adding a dependency, so neither skill fires. `placing-tests` explains
why there are three separate coverage floors and `managing-dependencies` explains what
each supply-chain setting closes off; the prohibition itself is here.

## Enforcement layers

The rules above are enforced by two layers, from mechanical to procedural. Each layer
holds only what belongs there — the rule itself lives in exactly one place, never copied
between layers:

| Layer                 | Fires on              | Applies to             | Holds                                                                                                 |
| --------------------- | --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `lefthook` pre-commit | `git commit`          | every author, any tool | Formatting, `eslint`, `typecheck`, `agents:check`, a related-test run, and the one content rule below |
| This file             | read at session start | every agent            | Everything else — the reasons behind the rules above                                                  |

The first row's "every author" is not a second step anybody has to remember, and not
something `prepare` arranges either. `lefthook` ships its own `postinstall`, which
`pnpm-workspace.yaml`'s `allowBuilds` allowlists, so every non-CI `pnpm install` writes
the hook by itself. What that postinstall cannot do is fail: it never reads the exit
status of the `lefthook install -f` it spawns, so an install that could not write the
hook — a `core.hooksPath` pointing somewhere it cannot create — leaves `pnpm install`
green, the gate absent, and nothing on screen. `package.json`'s `prepare` script runs
`scripts/verify-hooks.mjs` after that, and it **verifies rather than installs**: it
fails the install with an `ERR_HOOKS_*` report unless `lefthook.yml` declares a
`pre-commit` block and a lefthook pre-commit hook really sits at the path
`git rev-parse --git-path hooks` names. Both halves are checked because either alone is
satisfiable while the gate is absent — `lefthook install` writes a blank config and
calls that success — and the path is resolved rather than assumed, because
`core.hooksPath` and a linked worktree both move it legitimately.

Verification skips, and the install succeeds, only where it is meaningless: `CI` set, a
directory that is not a Git work tree root, and an install that left no `lefthook` in
`node_modules`. Most of the remaining ways to end up without the gate are deliberate or
visible: `pnpm install --ignore-scripts`, which runs neither lifecycle script;
`ALLOW_MISSING_GIT_HOOKS=1`, the documented opt-out for a developer who genuinely cannot
have the hook, which every failure message names; and hooks removed by hand afterwards.
`LEFTHOOK=0` is not among them: it leaves the hook installed and `verify-hooks` green
while disabling the gate at every commit it is set for — "Two consequences" below is
where that invisibility, and why nothing here closes it, is explained once.
`pnpm hooks:install` is the repair, not a setup step.

No third layer sits under those two: this repository ships no declarative,
tool-call-aware permission list (a Claude Code `permissions.allow`/`permissions.deny` or
equivalent) — "Security and human approval" above is the one place that records what the
committed configuration does declare, and what an agent has to arrange for itself
outside this repository. The one rule that must hold regardless of which tool or human
is committing — a secret about to land in history — is instead the single mechanical
layer this repository does ship: `lefthook`'s pre-commit hook, which every author goes
through the same gate for.

Two consequences of that shape are worth naming rather than discovering: a shell command
that reads a secret path outside a commit (`cat .env`, `cp .env /tmp/x`) is invisible to
the hook, since it only inspects what is staged; and turning the Git hooks off through
the environment (`LEFTHOOK=0 git commit …`) is invisible to the hook it disables, with
nothing else in the repository watching for it. Neither is enforced anywhere. "Never
read or write `.env*` or anything under `secrets/`" and "never bypass the hooks" hold as
instructions in this file, not as blocks — reaching for either spelling is the thing
being ruled out, not the spelling that happens to be caught.

`scripts/lib/guard/` is the rule engine `scripts/check-staged.mjs` (the pre-commit
layer) uses to decide whether a staged path or its content is secret-shaped. That is the
whole of its scope, on purpose.

The hook deliberately does **not** try to stop a commit from deleting a workflow,
relaxing a config, or lowering a threshold. Those are judgement calls, and a judgement
call belongs in the pull request, where a reader can weigh it and disagree — a hook
cannot. A hook that blocks legitimate work teaches its author to reach for
`--no-verify`, and that flag disables the secret check along with everything else, so a
narrow hook that never fires on intended work protects more than a broad one that has to
be routed around. "Never weaken a gate to make a run pass" therefore holds as an
instruction in this file and as something a reviewer checks, not as a block.

Hand-editing `pnpm-lock.yaml` is the clearest example of a rule this repository accepts
as unenforced rather than mechanically blocked: a regenerated lockfile (`pnpm install`)
is an ordinary, expected commit, and a git diff cannot tell that apart from a hand edit
— only a layer that sees the actual tool call that produced the change could, and none
is enforced here. "The lockfile is generated, never hand-edited" holds as an
instruction, the same way the rules above it do.

A skill holds the reasoning behind a rule and the judgment a config cannot express; it
never holds a value a config owns, and never holds a prohibition an agent would meet
while its declared task is something else.

## Conventions

- All committed code, comments, configuration, and public documentation are in English.
  `authoring-skills` applies this to a skill's `description`. The one exception is
  `messages/*.json`: those are the UI message catalogs the application renders to a
  reader, so `messages/ja.json` is Japanese by definition. The exception covers the
  catalogs' string values and nothing else — their keys, and every comment, test, and
  document about them, stay English. The one thing that may itself be non-English is a
  literal whose exact bytes are what a check or a worked example exercises, where
  writing it in English would destroy what it demonstrates —
  `tests/placeholders.test.ts`'s `PLACEHOLDERS` is the case to compare against, for the
  reason recorded there. Nothing wider: the prose around such a literal stays English —
  a test's `describe` and `it` names, its assertion messages, its comments, and a
  document's own sentences.

- **A comment carries only what the code cannot** — a non-obvious why, a trap the next
  edit would spring, an external constraint. Default to none and keep the rest to a line
  or two. Restating the code, or narrating decision history, is what the code and git
  already do. TSDoc on the published surface is a contract and stays.

- Do what was asked; nothing more. Prefer editing an existing file to creating a new
  one, and do not add documentation files that were not requested.
- Note improvements you spot outside the current scope instead of making them.
