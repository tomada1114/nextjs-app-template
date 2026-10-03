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

1. **Agent:** rename using the identity inventory, before writing anything against the
   template's identity.
2. **Human:** settle purpose, users, core actions and non-goals. **Agent:** fill
   AGENTS.md's Product section and remove its settled marker and inventory row.
3. **Human:** decide whether the app keeps the AI layer. **Agent:** keep it or follow
   the whole-layer removal procedure before app-specific server modules grow around it.
4. **Human:** choose the locales. **Agent:** follow the locale checklist and its checks.
5. **Agent:** research the design options. **Human:** choose the direction before the
   first app screen. **Agent:** settle the lock and tokens and run their checks.
6. **Agent:** run `pnpm check:source` on the resulting application. Each procedure names
   the narrower checks to run during its own step.
7. **Human:** enable the new repository's settings and apply `pnpm repo:ruleset` as soon
   as the repository exists, before its first PR merges. **Agent:** prepare the files
   and verification; settings writes remain the owner's step. For a private repository,
   settle the feature and replacement-gate decision below first.

## The GitHub settings

"Use this template" copies the tree and none of the repository's settings, so the new
repository starts with no branch protection, no private vulnerability reporting and no
Dependabot alerts. As soon as it exists — before its first pull request merges — work
through AGENTS.md's "GitHub settings a new repository must enable", which holds the list
and the reasons. Each item is a remote write the owner signs off on, and most are
switches only the owner can flip. When the new app renames or drops a CI job, edit
`.github/rulesets/main.json` in the same change and run `pnpm repo:ruleset` again;
`tests/ruleset-contexts.test.ts` fails while the two disagree.

For a private app, follow
[the private-repository procedure](references/private-repository.md) to check
security-feature availability, obtain the owner's gate decision, and reconcile only
affected required contexts before the first merge.

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

Follow [the removal procedure](references/removing-ai.md). Read and run
`tests/ai-layer-removal.test.ts` before deleting anything; it supplies the exact removed
and edited paths while the layer is still present.

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
