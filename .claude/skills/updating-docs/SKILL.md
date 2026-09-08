---
name: updating-docs
description: >
  Decides whether a change owes a documentation update and which surface it lands on:
  README.md, CONTRIBUTING.md, AGENTS.md, a skill under .agents/skills/, .env.example, or
  a TSDoc comment on a published symbol. Use when triaging whether a pull request needs
  a document changed at all, when a rule or an architecture boundary moved and it is
  unclear which file owns it, when the quick start or the setup steps drifted, or when
  deciding that an internal refactor needs no documentation change.
---

# Updating Documentation

**Owns:** whether a change owes a documentation update, and which surface it lands on.
**Does not own:** what a TSDoc comment for a given symbol actually says
(`writing-typescript`); how a skill is authored and mirrored (`authoring-skills`); what
goes into a message catalog (`localizing-ui`); the procedure behind the README's
"Starting a new app from this template" section (`starting-an-app`).

## Decide on observability, not location

Documentation impact is decided by what a **reader can observe**, not by which directory
the edit began in. An internal refactor and a test-only change need no documentation
change — say so explicitly. Deciding that nothing is needed is a legitimate outcome of
this skill, not a shortcut to be double-checked away.

What counts as observable is not this skill's to define. AGENTS.md's "What is contract
and what is private" holds that list and is its only copy; read it there. A restatement
here is exactly how the paragraph this replaced went stale — it was still describing a
published library's signatures, Node floor and installation step long after this
repository stopped being one.

## When a change reaches README.md or CONTRIBUTING.md

`CONTRIBUTING.md`'s "Pull requests" section defers that question to this skill, so
answer it rather than deferring back:

- `README.md` changes when the first ten minutes with a checkout change — the quick
  start commands, what the one API route takes or answers, or where a new app begins.
- `CONTRIBUTING.md` changes when setup, the toolchain versions, the dependency cooldown,
  or the pull request process changes.
- Neither changes for a refactor, a test, a gate or a rule that AGENTS.md owns, or an
  edit to a skill.

## Purpose per file

Each surface has one job; do not blur them, and do not let one grow a second copy of
another's content.

- `README.md` — the tour: what this template is, how to run it, and where copying it
  into a new app starts. It links to `AGENTS.md` and `CONTRIBUTING.md` instead of
  repeating them, so it must not grow a second command index or a second rule list.
- `AGENTS.md` — the agent-facing guide: the architecture, the zone boundaries, the Quick
  reference command index, the rules, and the Skills routing table. A changed boundary,
  gate rule, or `pnpm` command lands here.
- `CONTRIBUTING.md` — local setup, the dependency cooldown, and the pull request
  process. Nothing here is published, so it describes no release step.
- `.agents/skills/<name>/SKILL.md` — the conventions of one kind of change, loaded on
  demand. `authoring-skills` owns how one is written, mirrored, and checked.
- `.env.example` — every environment name the process reads, shipped with an empty
  value. It is the file to open when the question is what exists.
- TSDoc in `src/**` — a published symbol's contract. The language-model port's request
  and response types are where this matters most: they are what an adapter author reads
  instead of reading the adapter that happens to ship. `writing-typescript` owns what
  the comment says; this skill owns only whether one is owed.

There is no `CHANGELOG.md` and no `docs/` tree here. A pull request explains itself in a
line or two, and `.github/PULL_REQUEST_TEMPLATE.md` owns that — do not reinstate either.

## A skill is documentation; editing one is usually not a doc change

Both halves are true and the tension is worth holding. A `SKILL.md` is documentation —
for an agent rather than for a person — so it is held to the same prose rules as the
files above. But maintaining one is not itself user-observable, and it obliges no
README, CONTRIBUTING or AGENTS.md edit.

The one exception is the skill set changing shape: a skill added, renamed, or deleted
has to be recorded in AGENTS.md's Skills table, and widening a skill's subject means
widening its row. `tests/skills-frontmatter.test.ts` asserts the table and the authored
directory list agree in both directions, so a missed row fails the suite rather than
going quietly.

## The checklist owns the mechanical items

`.github/PULL_REQUEST_TEMPLATE.md` already carries the two items that fire most often —
the one for a new environment variable and the one for a new UI string. Work from the
template; this skill does not restate its items and neither should anything else.
`localizing-ui` owns the catalog procedure behind the second of them, and AGENTS.md's
Conventions owns the English rule and the one exception the catalogs get.

## What belongs in prose

Document non-obvious behavior, architecture decisions, and trade-offs. Do not restate
what the code or the type system already says — the same principle TSDoc follows in
`src/**`. If a reader could get the fact from the signature or from running the code, it
does not need a sentence here.

## Nothing verifies a fenced example

No gate in this repository compiles or runs a code block in a document, and none checks
that a documented command still exists. Do not add one — a lint rule or a checklist item
promising it would be one more thing to keep true, and a document that claims a gate it
does not have is worse than one that stays silent.

That leaves a discipline instead. Keep a fenced example to something a reader can check
by eye — a command, a request body, a path. When the example has to be runnable, put the
runnable thing in `src/`, where a test already calls it, and have the document point at
it rather than copy it.

## Generated trees are off-limits

`.claude/skills/` is a generated mirror of `.agents/skills/` (`pnpm agents:sync`) —
never hand-edit it, and never include it in a documentation sweep. Edit the authored
file and re-run the sync; `authoring-skills` owns the rest.
