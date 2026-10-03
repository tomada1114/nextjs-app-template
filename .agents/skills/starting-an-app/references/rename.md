# Rename and foundation

## The rename

`tests/placeholders.test.ts` owns the inventory: `PLACEHOLDERS` is every string that
names _this template_ rather than a project built from it, and `EXPECTED_INVENTORY` is
the complete list of `<file>: <placeholder>` sites where one still stands. That list is
the checklist, and it is machine-checked, so this skill does not restate its rows —
holding them in two places is how one of them goes stale.

Work through the identity sites first; leave the product and design-direction rows for
the steps that follow the rename:

```bash
pnpm exec vitest run tests/placeholders.test.ts
```

The inventory is pinned with an exact comparison, so a failure prints the sites that
remain against the sites the list expects. Replace one site, delete its row from
`EXPECTED_INVENTORY`, run again. The rename is finished when only the product and
design-direction rows remain and the suite is green. The whole starting procedure is
finished when the inventory is empty: no template identity or undecided product/design
marker survives anywhere in the tree.

The suite's second block, over the CI badge and the two security-advisory links, checks
those URLs by their _shape_ — the path segments and the workflow filename — and leaves
the owner and the repository unconstrained. It passes on your slug exactly as it did on
the template's, so it needs no edit during the rename; what pins the slug itself is the
inventory row for each of those files.

What goes into each site:

- **The package identity** — `package.json`'s `name` and `description`. `private: true`
  stays: nothing here is published, so the name only has to be one you recognise, not
  one that is free on the registry.
- **The repository slug**, wherever a URL names a GitHub repository — the README's CI
  badge, the security-advisory contact link in `.github/ISSUE_TEMPLATE/`, and the
  reporting link in `SECURITY.md`. A slug left behind renders a broken badge and sends a
  vulnerability reporter to a stranger's advisory form.
- **The security policy's commitments** — `SECURITY.md`'s "Response" section speaks for
  the template's maintainer. Replace it with what the new app's owner will actually
  promise, and keep "Supply-chain posture" true as the app's gates change: it states
  only what the repository does.
- **The copyright holder** in `LICENSE`, and the same name wherever the README repeats
  it. Every fork inherits `LICENSE` verbatim, which is why the template ships a blank.
- **The app's display name** — `Metadata.title` in every catalog under `messages/`, read
  by `generateMetadata` in `src/app/[locale]/layout.tsx` for the browser tab, and each
  catalog's `HomePage.title`, which is the page heading. Both are per-locale; write the
  name in each catalog's language.
- **The one-line description** — `Metadata.description` in every catalog under
  `messages/`, read by that same `generateMetadata` for `<meta name="description">` and
  so for search results and link previews. Give each locale its own description; the
  layout reads the catalogs rather than holding a literal to replace.

Those are the only reader-visible strings the inventory covers. The home page's body
text — each catalog's `HomePage.intro` and `HomePage.localeCount`, which still describe
the page as a template — is deliberately left out: it is demo copy for a demo page you
are expected to rewrite or delete, so pinning it would pin strings that may not survive
your first day, and one of them is quoted in `localizing-ui` as a worked example that
has nothing to do with your identity. Review that copy by hand once the page is yours.
`tests/home-page.test.tsx` asserts the English `intro` as a literal, so rewriting it
turns that test red; update the assertion in the same edit.

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
