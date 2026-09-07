---
name: public-api-contract
description: >
  Covers what may be published from src/index.ts, how src/internal/ stays private, and
  how package.json's exports/files allowlists and the @public TSDoc tag declare the
  surface. Use when adding or removing an export in src/index.ts, deciding whether a
  symbol belongs in src/internal/, or deciding what src/index.ts may re-export.
---

# Public API Contract

**Owns:** what the published surface may contain and how it is declared. **Does not
own:** the same-PR checklist and the semver decision (`release-impact`), the type-system
judgment, naming, and constant placement inside a module (`writing-typescript`), or how
the surface is tested (`writing-tests`, `type-testing`).

## Layout

AGENTS.md's Architecture section carries the `src/` tree — `src/index.ts`,
`src/internal/`, and the `*.ts` modules it re-exports. What follows is what each part of
that tree may publish, not the tree itself.

## `src/index.ts` is the entire contract

- `src/index.ts` is the single entry point of the public contract. Every public symbol
  is re-exported from it **by name**. There is no default export and no `export *`, so
  the published surface is always something you can read in one file, top to bottom.
  Enforced by: `eslint.config.mjs`'s `no-restricted-syntax` (blocks
  `ExportAllDeclaration`) and `no-restricted-exports` (blocks default exports).
- Adding a line to `src/index.ts` makes that symbol public API. Decide that deliberately
  at the moment you write the line — this is the decision point, not something to catch
  later at review time.
- Removing a line is equally a break: a consumer's import stops resolving. Treat a
  removal with the same weight as an addition.

`src/cli.ts` is an optional command entry, not a second import surface. A package may
name its emitted `dist/cli.js` through `package.json#bin`; that command is exercised
through its `argv`/exit/output behavior rather than re-exported from `src/index.ts`.
Keeping command code out of the import surface avoids turning a runnable entry into
public API by accident.

## `src/internal/` is private

- `src/internal/` is private regardless of what a file inside it is named — the
  directory, not the name, is what makes it private. Exporting one of its symbols from
  `index.ts` publishes it. Enforced by the public-api/internal-stays-private block in
  `eslint.config.mjs`, a `src/index.ts`-scoped `no-restricted-syntax` rule.
- Nothing outside `src/**` may import from `src/internal/` directly; reach it only
  through what `index.ts` re-exports. Enforced by the
  boundaries/internal-is-not-importable block in `eslint.config.mjs`, a
  `no-restricted-imports` rule over `tests/**/*.ts` and `scripts/**/*.mjs`. It covers
  the built copy under dist as well as the source — the same private module either way.

## `package.json` allowlists

- `exports` and `files` in `package.json` are allowlists, not documentation of intent. A
  path not listed in either is private, and a deep import into `dist/` — reaching past
  the allowlist into an internal module — is expected to fail for a consumer even if the
  file exists on disk.
- A new subpath export (a second entry under `exports`, a deep export) is a
  public-surface decision with the same weight as a new symbol in `index.ts` — it is not
  a packaging detail to slip in separately.

## Declaring intent on each symbol

- Every public declaration carries a TSDoc release tag, `@public`. No build step fails
  over a missing one — it is a convention for readers, so a symbol reachable from
  `index.ts` says out loud that it is part of the contract rather than something
  re-exported by accident.
- A public symbol with no TSDoc at all, or one whose type references something
  unexported, leaves a reader unable to name that type. Nothing enforces this
  mechanically any more — the doc build that did was removed with the publish gates — so
  it is a review expectation.

**REQUIRED:** `release-impact` for what a change to this surface obliges the same pull
request to carry.
