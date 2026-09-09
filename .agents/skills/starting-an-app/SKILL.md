---
name: starting-an-app
description: >
  Covers turning this template into a new application: the copy-and-rename procedure
  driven by tests/placeholders.test.ts, what a new project keeps untouched, removing the
  AI layer whole under tests/ai-layer-removal.test.ts, and whether to keep both locales
  or drop one. Use when starting an app from this repository, replacing the package
  name, the app's display name or the repository slug in a badge or advisory link,
  deleting src/ai/ and the route that depends on it, or dropping a locale from
  src/i18n/locales.ts and messages/.
---

# Starting an App

**Owns:** turning this repository into a new application — the rename, what the new app
keeps, removing the AI layer whole, and the locale decision. **Does not own:** how a
skill is authored or mirrored (`authoring-skills`); the README's own prose
(`updating-docs`); what a gate file may contain (`changing-gates`); working inside the
App Router tree (`building-app-routes`); the port, its adapters, and swapping one
provider for another (`integrating-llm`).

There is deliberately no bootstrap script. The one this repository used to ship was
profile-driven machinery that rewrote the tree and then deleted itself, so the only
record of what it did was a file that no longer existed. What replaced it is this
procedure plus two tests holding the lists a script would have hard-coded. Do not
reintroduce a script, a profile, or a self-deleting block.

## The order

Rename first, so nothing downstream is written against the template's identity. Decide
the AI layer next — keep it or remove it whole — before writing code of your own:
removal touches `eslint.config.mjs`, `vitest.config.ts` and AGENTS.md, and doing it once
your own modules have grown into `src/server/` turns a bounded deletion into a merge.
Decide the locales last, then run `pnpm check:source` once. Each step below names the
narrower check to run while you are inside it.

## The rename

`tests/placeholders.test.ts` owns the inventory: `PLACEHOLDERS` is every string that
names _this template_ rather than a project built from it, and `EXPECTED_INVENTORY` is
the complete list of `<file>: <placeholder>` sites where one still stands. That list is
the checklist, and it is machine-checked, so this skill does not restate its rows —
holding them in two places is how one of them goes stale.

Work through it:

```bash
pnpm exec vitest run tests/placeholders.test.ts
```

The inventory is pinned with an exact comparison, so a failure prints the sites that
remain against the sites the list expects. Replace one site, delete its row from
`EXPECTED_INVENTORY`, run again. You are finished when the list is empty and the suite
is green: an empty inventory means no identity string of this template survived anywhere
in the tree, not merely in the files someone remembered to open.

The suite's second block, over the CI badge and the security-advisory link, checks those
two URLs by their _shape_ — the path segments and the workflow filename — and leaves the
owner and the repository unconstrained. It passes on your slug exactly as it did on the
template's, so it needs no edit during the rename; what pins the slug itself is the
inventory row for each of those files.

What goes into each site:

- **The package identity** — `package.json`'s `name` and `description`. `private: true`
  stays: nothing here is published, so the name only has to be one you recognise, not
  one that is free on the registry.
- **The repository slug**, wherever a URL names a GitHub repository — the README's CI
  badge and the security-advisory contact link in `.github/ISSUE_TEMPLATE/`. A slug left
  behind renders a broken badge and sends a vulnerability reporter to a stranger's
  advisory form.
- **The copyright holder** in `LICENSE`, and the same name wherever the README repeats
  it. Every fork inherits `LICENSE` verbatim, which is why the template ships a blank.
- **The app's display name** — the `title` in `src/app/[locale]/layout.tsx`'s
  `metadata`, which is the browser tab, and the `HomePage.title` key in
  `messages/en.json` and `messages/ja.json`, which is the page heading. This is the only
  reader-visible copy this checklist covers, and the only one that is per-locale: each
  catalog gets the name written in its own language. Other reader-visible copy — the
  `description` in that same `metadata` block, and the home page's body text in each
  catalog's `HomePage.intro` and `HomePage.localeCount` — is deliberately not
  inventoried here; review it by hand as part of the renaming project.

Emptying `EXPECTED_INVENTORY` is the intended edit and is not weakening a gate. Widening
`SKIPPED_DIRECTORIES` or `SKIPPED_FILES`, or dropping an entry from `PLACEHOLDERS`, to
make a row disappear is — the row would stop being reported without the string being
gone. AGENTS.md's "never weaken a gate to make a run pass" covers that.

## What the new app keeps

Everything below is about the repository rather than the application, so it survives the
rename unchanged and is most of what starting from this template buys:

- **The gate set** — `package.json`'s `check:quick` / `check:source` and the scripts
  they call, `lefthook.yml`, and `.github/workflows/`. A red run early in a new project
  is an argument for fixing the code, never for deleting the check that found it.
- **The guard engine** — `scripts/lib/guard/` and `scripts/check-staged.mjs`, the one
  mechanical layer this repository ships and the only thing standing between a secret
  and the commit history. It is language-agnostic; keep it whatever the app becomes.
- **The skills** under `.agents/skills/` and their generated mirror. Drop one only when
  the subject it owns actually leaves the repository — removing the AI layer removes
  `integrating-llm`, and `tests/ai-layer-removal.test.ts` names it rather than leaving
  the call to memory. **REQUIRED:** `authoring-skills` for the loop that keeps the two
  trees identical, and for the AGENTS.md Skills table row that
  `tests/skills-frontmatter.test.ts` requires in both directions.
- **The label workflow** — `.github/labels.yml`, `scripts/sync-labels.mjs` behind
  `pnpm repo:labels`, and `.github/workflows/pr-label.yml`. Run `pnpm repo:labels`
  against the new repository early: the workflow only ever _applies_ a label, and when
  one does not exist yet it emits a notice instead of failing, so a missing taxonomy is
  silent. **BACKGROUND:** `triaging-issues` for what the labels mean.
- **`.env.example`**, even when the app reads nothing yet. `src/server/env.ts` is the
  only module that touches `process.env`, and `tests/server-env.test.ts` asserts the two
  stay in step; the example file is half of that check.

## Removing the AI layer

`tests/ai-layer-removal.test.ts` is the specification. Read it, then run it **before**
deleting anything:

```bash
pnpm exec vitest run tests/ai-layer-removal.test.ts
```

Green means the layer is still separable and the five lists in that file are complete —
the property it exists to defend, checkable only while the layer is present. It cannot
be the check you run afterwards, because it is on its own removal list. Those five lists
are the procedure:

- **`REMOVED_PATHS`** — deleted outright. `src/server/composition.ts` is on it because
  wiring a port is the whole of what that file does, `src/app/api` because the one route
  there is the layer's only caller, and the `integrating-llm` skill with its
  `.claude/skills/` mirror because the subject it documents is what leaves.
- **`AI_LAYER_TOKENS`** — `ANTHROPIC_API_KEY` and `@anthropic-ai`, the two vendor names
  a file can carry without naming a path.
- **`REMOVED_SKILL_NAMES`** — the bare name of every skill on `REMOVED_PATHS`, derived
  from it rather than listed again; today just `integrating-llm`. Sibling skills
  cross-reference each other by name and never by path, so without this a
  `**BACKGROUND:** \`integrating-llm\`` line would survive the removal unnoticed.
- **`EDITED_CODE_FILES`** — files that survive but must stop naming it, whose subject is
  the repository's machinery. That this list is short, and holds no application module,
  _is_ the separability property.
- **`EDITED_DOCUMENT_FILES`** — files that survive but must stop describing the layer to
  a reader. This one claims completeness and nothing else: it grows whenever a skill
  teaches a rule through the port or the handler, and that growth is expected.

Delete the paths, then work through both edited lists:

- `src/server/env.ts` loses the key from its schema and `.env.example` the matching
  line. `API_ACCESS_KEY` and the rule requiring it stay: the rule is keyed off what the
  composition root wires (`requiresAccessKey`), not off a vendor's variable, so it
  survives the vendor leaving and is waiting for the first endpoint of your own that
  costs money to answer. Keep `src/server/env.ts` itself, empty schema and all — it is
  the seam the next secret enters through, and deleting it means rediscovering where
  `process.env` is allowed to be read.
- `eslint.config.mjs` loses the vendor-SDK zone rules, and `tests/boundaries.test.ts`
  the cases asserting them.
- `vitest.config.ts` loses the deleted suites from `automationTests` and the removed
  zone from its coverage glob. Narrowing a glob over a directory that no longer exists
  is not lowering a floor; no threshold number moves, and none may.
- `README.md` and AGENTS.md lose the route and the port from their prose — AGENTS.md's
  Architecture tree, its three seams, and the contract statement all name them.
- `tests/server-env.test.ts` loses the cases for the removed key.
- `building-app-routes` loses the paragraphs written around the one endpoint that is
  going away: the Route Handler pattern it teaches stays, and the first endpoint of your
  own is what it is illustrated with instead.
- `writing-typescript` and `designing-errors` lose the worked examples drawn from the AI
  layer — the port's error vocabulary, the handler's `satisfies` status table, the abort
  helpers. Every rule they illustrate outlives the layer, so each example is replaced by
  one from your own code rather than deleted with its rule.
- `localizing-ui` loses its `outputLanguage` section — that seam is the port's, and the
  UI locale it maps from has nowhere left to reach. Everything else in it, the catalogs
  and the locale routing, is untouched by this removal.
- `managing-dependencies` loses the whole paragraph describing how an
  `@anthropic-ai/sdk` bump is verified: the `tests/fixtures/llm/` path,
  `tests/llm-replay.ts`, the `LLM_RECORD` variable, and the cross-reference to
  `integrating-llm` all leave with the layer. What survives is the fact that no suite
  reaches a live service, now true of every suite rather than split between a fake
  adapter and one replayed from fixtures.
- `integrating-llm` is deleted rather than edited: its whole subject is the layer.
- `writing-tests` loses the two seams that are going away — the port contract suite and
  the handler driven with `new Request()` — and `type-testing` the port's generic
  request and response types. Both keep everything else: the component and Route Handler
  seams, the traps, and the typed message keys in `src/i18n/messages.ts`, which are not
  the AI layer's.
- This skill loses its "Removing the AI layer" section — it is on
  `EDITED_DOCUMENT_FILES` because a procedure for deleting something already gone is
  stale prose. Edit the `.agents/` copy and run `pnpm agents:sync`; never hand-edit the
  mirror.

Delete `tests/ai-layer-removal.test.ts` last: it is the checklist while you work, and
the first dangling reference the moment the paths are gone. The proof that nothing
dangles afterwards is the gate — `pnpm check:source` type-checks, lints, builds and
tests the tree that remains, which is exactly the set of failures a stale import, a
stale zone rule or a stale test would produce.

## The locale decision

The template ships `en` and `ja`. Keeping both costs nothing and is the default; the
other choice is dropping one, and a third locale is added by reading the same list
forward. Dropping `ja` touches:

- `src/i18n/locales.ts` — `LOCALES`, which is the closed union everything else derives
  from.
- `messages/ja.json`, deleted, and `src/i18n/messages.ts`, which statically imports it,
  keys `MESSAGES` by locale, and lists its switcher key in `MESSAGE_KEYS`.
- `messages/en.json` — the switcher entry naming the dropped language.
- `src/server/handlers/ask.ts` — `OUTPUT_LANGUAGE_BY_LOCALE`, the one place a UI locale
  is mapped to the language the model writes in. Only if the AI layer stayed.
- `tests/messages.test.ts`, `tests/proxy.test.ts`, `tests/home-page.test.tsx`, and
  `tests/server-handler.test.ts`, each of which names the locale literally.
- `README.md`'s quick start, and AGENTS.md's Conventions exception, which names
  `messages/ja.json` as the one committed file that is not in English.

`src/proxy.ts` does **not** change: its matcher excludes API routes, framework asset
trees and paths with an extension, and names no locale at all. `tests/proxy.test.ts`
does change, because its cases spell one out.

Two of these fail at compile time rather than at runtime, by design:
`OUTPUT_LANGUAGE_BY_LOCALE` and `MESSAGE_KEYS` are written with `satisfies`, so a locale
removed from `LOCALES` without its entries removed fails `pnpm typecheck` instead of
rendering a key as its own name in production. Check with:

```bash
pnpm exec vitest run tests/messages.test.ts tests/proxy.test.ts
```

One locale still means a prefixed URL: `localePrefix` defaults to `"always"` in
`src/i18n/routing.ts`, so `/` keeps redirecting to `/en`. Changing that is a routing
decision, not part of the rename, and it is what `tests/proxy.test.ts` asserts either
way.
