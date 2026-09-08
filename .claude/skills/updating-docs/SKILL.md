---
name: updating-docs
description: >
  Decides whether a change needs a documentation update and which surface it lands on —
  README.md, CONTRIBUTING.md, or TSDoc in src/** — for edits touching src/index.ts,
  README.md, or CONTRIBUTING.md. Use when triaging whether a PR needs a doc change,
  updating the README example after an API change, or deciding if an internal refactor
  needs no docs at all.
---

# Updating Documentation

**Owns:** whether a change needs a documentation update, and which surface it lands on.
**Does not own:** what a TSDoc comment for a given symbol actually says
(`writing-typescript`).

## Decide on observability, not location

Documentation impact is decided by what a **user can observe**, not by which directory
the edit began in. An internal refactor, a test-only change, and skill maintenance under
`.agents/skills/` or `.claude/skills/` need no documentation change — say so explicitly.
Deciding that nothing is needed is a legitimate outcome of this skill, not a shortcut to
be double-checked away.

A change is user-observable when it alters a signature, a default, an observable runtime
behavior, an error's `code`, a supported Node version, or an installation step. If none
of those moved, stop here.

## Sweep the right surfaces

When a change is user-observable, sweep every surface it touches — do not stop at the
first one that seems relevant:

- The README example, if the change affects what it shows.
- `CONTRIBUTING.md`, if the change affects setup, the commands, or the PR process.
- TSDoc comments in `src/**` for the symbol that changed.

## Purpose per file

Each file has one job; do not blur them:

- `README.md` — the value proposition readable in 30 seconds, the install command, a
  minimal working example, supported Node/runtime versions, and a pointer to the full
  API reference. Nothing more.
- `CONTRIBUTING.md` — local setup, the main `pnpm` commands, how to run tests, release
  intent, and the PR process.
- There is no `CHANGELOG.md` and no `docs/` tree here.

## What belongs in prose

Document non-obvious behavior, architecture decisions, and trade-offs. Do not restate
what the code or the type system already says — the same principle TSDoc follows in
`src/**`. If a reader could get the fact from the signature or from running the code, it
does not need a sentence here.

## Code examples must compile

Every fenced `ts` example in README.md and every `@example` block in `src/**` is
compiled against the current public API by `tests/docs.test.ts` — do not invent a second
synchronization mechanism (a lint rule, a manual checklist item) to cover the same
ground; that test is the gate. A change to `src/index.ts` that breaks a documented
snippet fails that test, and the fix is to update the snippet in the same commit as the
signature change, not to adjust the test.

## Generated trees are off-limits

`.claude/skills/` is a generated mirror of `.agents/skills/` (`pnpm agents:sync`) —
never hand-edit it, and never include it in a documentation sweep. Edit the authored
file and re-run the sync; `authoring-skills` owns the rest.
