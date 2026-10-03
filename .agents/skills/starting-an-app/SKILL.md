---
name: starting-an-app
description: >
  Covers turning this template into a new application: the copy-and-rename procedure
  driven by tests/placeholders.test.ts, what a new project keeps untouched, removing the
  AI layer whole under tests/ai-layer-removal.test.ts, whether to keep both locales or
  drop one, and settling the design direction before the first screen. Use when starting
  an app from this repository, replacing the package name, the app's display name or the
  repository slug, deleting src/ai/, dropping a locale from src/i18n/locales.ts and
  messages/, or replacing the stock shadcn/ui tokens.
---

# Starting an App

**Owns:** turning this repository into a new application — the rename, what the new app
keeps, removing the AI layer whole, the locale decision, and when the design direction
gets settled. **Does not own:** how a skill is authored or mirrored
(`authoring-skills`); the README's own prose (`updating-docs`); what a gate file may
contain (`changing-gates`); working inside the App Router tree (`building-app-routes`);
the port, its adapters, and swapping one provider for another (`integrating-llm`); what
a settled direction contains and how the tokens are edited (`designing-ui`).

There is deliberately no bootstrap script. The one this repository used to ship was
profile-driven machinery that rewrote the tree and then deleted itself, so the only
record of what it did was a file that no longer existed. What replaced it is this
procedure plus two tests holding the lists a script would have hard-coded. Do not
reintroduce a script, a profile, or a self-deleting block.

## The order

Rename first, so nothing downstream is written against the template's identity. Fill
AGENTS.md's Product section next: purpose and users, core actions, and human-owned
non-goals. Remove its marker and inventory row once those are settled. Decide the AI
layer next — keep it or remove it whole — before writing code of your own: removal
touches `eslint.config.mjs`, `vitest.config.ts` and AGENTS.md, and doing it once your
own modules have grown into `src/server/` turns a bounded deletion into a merge. Decide
the locales, then settle the design direction before building the first screen of your
own — every screen written against the stock tokens is one to restyle later. Run
`pnpm check:source` once at the end. Each step below names the narrower check to run
while you are inside it. The GitHub settings stand apart from that sequence: turn them
on as soon as the repository exists.

## The GitHub settings

"Use this template" copies the tree and none of the repository's settings, so the new
repository starts with no branch protection, no private vulnerability reporting and no
Dependabot alerts. As soon as it exists — before its first pull request merges — work
through AGENTS.md's "GitHub settings a new repository must enable", which holds the list
and the reasons. Each item is a remote write the owner signs off on, and most are
switches only the owner can flip. When the new app renames or drops a CI job, edit
`.github/rulesets/main.json` in the same change and run `pnpm repo:ruleset` again;
`tests/ruleset-contexts.test.ts` fails while the two disagree.

## The rename

Follow the [identity inventory and foundation checklist](references/rename.md). Leave
the product and design rows for their later steps.

## The product

Fill AGENTS.md's Product section immediately after the rename. Remove its marker row
from `EXPECTED_INVENTORY` and rerun `tests/placeholders.test.ts`; keep the marker in
`PLACEHOLDERS` so it cannot return unnoticed. Non-goals change only by human decision.

## What the new app keeps

The [foundation checklist](references/rename.md#what-the-new-app-keeps) names the
repository machinery that survives the rename.

## Removing the AI layer

`tests/ai-layer-removal.test.ts` is the specification. Read it, then run it **before**
deleting anything:

```bash
pnpm exec vitest run tests/ai-layer-removal.test.ts
```

Green means the layer is still separable and the lists in that file are complete — the
property it exists to defend, checkable only while the layer is present. It cannot be
the check you run afterwards, because it is on its own removal list. Those lists are the
procedure:

- **`REMOVED_PATHS`** — deleted outright. `src/server/composition.ts` is on it because
  wiring a port is the whole of what that file does, `src/app/api` because the one route
  there is the layer's only caller, and the `integrating-llm` skill with its
  `.claude/skills/` mirror because the subject it documents is what leaves.
- **`AI_LAYER_TOKENS`** — `OPENROUTER_API_KEY`, the vendor name a file can carry without
  naming a path. **`AI_LAYER_SYMBOLS`** is the other half: the names this repository
  gives the layer's own surface — `LLM_MODEL` and `LLM_ADAPTER` among them — which a
  document cites as often as it cites a path.
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

- `src/server/env.ts` loses `OPENROUTER_API_KEY`, `LLM_MODEL` and `LLM_ADAPTER` from its
  schema, along with the provider key's half of the billed rule, and `.env.example` the
  matching lines. `API_ACCESS_KEY` and its half of the rule stay, build-phase deferral
  included: the rule is keyed off what the composition root wires (`billsAProvider`),
  not off a vendor's variable, so it survives the vendor leaving and is waiting for the
  first endpoint of your own that costs money to answer. Keep `src/server/env.ts`
  itself, empty schema and all — it is the seam the next secret enters through, and
  deleting it means rediscovering where `process.env` is allowed to be read.
- `eslint.config.mjs` loses the AI layer's zone rules (`AI_LAYER_PRIVATE` and the
  `src/ai/` blocks), and `tests/boundaries.test.ts` the cases asserting them.
- `vitest.config.ts` loses the deleted suites from `automationTests` and the removed
  zone from its coverage glob. Narrowing a glob over a directory that no longer exists
  is not lowering a floor; no threshold number moves, and none may.
- `README.md` and AGENTS.md lose the route and the port from their prose — AGENTS.md's
  Architecture tree, its three seams, and the contract statement all name them.
- `tests/server-env.test.ts` loses the cases for the removed variables and the
  composition-root boot, and `tests/server-smoke.test.ts` its `LLM_ADAPTER=fake` pin
  along with the `POST /api/ask` cases.
- The skills on `EDITED_DOCUMENT_FILES` teach rules that outlive the layer and
  illustrate them with it. **Delete the illustration and leave the rule standing** — the
  sentence, the bullet, or the section whose _subject_ is the layer. Do not write a
  replacement now: you are here before your own code exists, and a rule with no example
  is still a rule. Add one when you have code worth pointing at.
- Grep to find the sites, then read the file: the needles
  `tests/ai-layer-removal.test.ts` lists — `REMOVED_PATHS`, `AI_LAYER_TOKENS`,
  `AI_LAYER_SYMBOLS` and `REMOVED_SKILL_NAMES` — are a lower bound, not a substitute for
  reading it. The skills on `EDITED_DOCUMENT_FILES` were written before
  `authoring-skills` required a new mention to carry a needle, so a paragraph can name
  the layer with none: `building-app-routes`' "Key any gate of this kind off what the
  composition root wires" paragraph names no path, token, symbol or skill, and a grep
  alone walks past it. A skill's frontmatter `description` is a site like any other: it
  is that skill's one trigger surface, and a trigger naming a file that is gone is dead
  weight nothing reports once this suite is deleted. Several descriptions name a removed
  path today, this skill's own among them.
- Two are not sentence surgery. `integrating-llm` is deleted rather than edited, its
  whole subject being the layer; and `localizing-ui` loses its `outputLanguage` section
  whole, heading included — that seam is the port's, and the UI locale it maps from has
  nowhere left to reach. The catalogs and the locale routing are untouched, but the
  section is not the only place `outputLanguage` appears: the skill's frontmatter
  `description` and its **Owns:** sentence both name the same seam and both need the
  same edit.
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

Follow the [locale checklist](references/locales.md) to keep both locales, drop one, or
add another, and run the checks it names.

## Settling the design direction

The template ships shadcn/ui's stock `neutral` tokens and an unsettled lock in
`designing-ui`, both carrying the design-direction marker that `PLACEHOLDERS` in
`tests/placeholders.test.ts` lists — so the same inventory run as the rename reports it,
one row for `src/app/globals.css` and one per copy of `designing-ui`'s `SKILL.md`.

Settle it before the first real screen, and research it rather than choosing by taste:
the user-level `refero-design` skill is the method when it is installed; without it,
`designing-ui` points at its `references/design-lock.md`, whose research procedure needs
no other skill. The choice is the human's either way — present the options and let them
pick. Then:

- Fill `designing-ui`'s lock and ledger in the shape that section gives, and replace the
  marker sentence and the paragraph under it with the settled direction. Edit the
  `.agents/` copy and run `pnpm agents:sync`.
- Replace the stock values in `src/app/globals.css`, keeping the `:root` +
  `@theme inline` shape, and replace its marker comment with one naming the direction.
  Fonts load through `next/font` in the layout that owns `<html>`; `pnpm build` then
  fetches them at build time, so a fresh build needs network access.
- Restyle `src/components/ui/button.tsx` to the settled recipe, dropping any variant the
  lock has no use for, and update `tests/ui-primitives.test.tsx` in the same edit.
- Delete the marker's rows from `EXPECTED_INVENTORY`. The marker stays in `PLACEHOLDERS`
  so it cannot come back unnoticed.

```bash
pnpm exec vitest run tests/placeholders.test.ts tests/ui-primitives.test.tsx
pnpm build && pnpm test:smoke
```
