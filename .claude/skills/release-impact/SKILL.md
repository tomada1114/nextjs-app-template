---
name: release-impact
description: >
  Use when deciding whether a change is breaking and which semver level (MAJOR, MINOR,
  PATCH) it deserves, whether a PR needs a release at all, or how to word the `Release
  impact:` line in a PR body; when adding, removing, renaming, or retyping anything
  exported from src/index.ts — normalizeIdentifier, withTimeout, InvalidInputError,
  TimeoutError, NormalizeIdentifierOptions, WithTimeoutOptions — or changing an error
  `code`.
---

# Release Impact

**Owns:** what a pull request must carry about its release consequences, and the semver
call. **Does not own:** what the public surface may contain (`public-api-contract`), doc
content (`updating-docs`), dependency ranges (`managing-dependencies`).

## Same-PR checklist

A change to the public surface is a change to a contract other people depend on. When
`src/index.ts` or anything it re-exports changes, everything it touches lands in the
**same pull request**:

1. the implementation in `src/`
2. behavior tests in `tests/`
3. type tests (`expectTypeOf`) for the new or changed signatures
4. the README example and any affected page under `docs/`
5. a release-impact note describing the change and its semver impact

No gate reconstructs this list for you. `pnpm run check:source` proves the new surface
builds and is tested; it cannot tell you whether the change was _meant_, or what it does
to the version. That is what the release-impact note has to say — write it, do not let
the gate stand in for it.

## State the decision in every PR

Every pull request states whether a release is required, so a reviewer can tell an
intentional no-release change from a forgotten decision. Write one of these two literal
forms in the PR body:

```
Release impact: yes — <MAJOR|MINOR|PATCH>. <one line: what changed and why>.
Release impact: no — <one line: why this change has no published effect>.
```

A missing statement is not a "no" — treat it as an incomplete PR and ask for the line
before approving.

## Deciding MAJOR, MINOR, or PATCH

Judge the diff against `src/index.ts`'s exported surface, not against the
implementation:

| Change                                                  | Level |
| ------------------------------------------------------- | ----- |
| Remove or rename an export                              | MAJOR |
| Narrow an accepted input type                           | MAJOR |
| Widen a required option (make an optional one required) | MAJOR |
| Change an error `code`                                  | MAJOR |
| Add an export                                           | MINOR |
| Add an optional option                                  | MINOR |
| Widen an accepted input type                            | MINOR |
| Reword an error `message`                               | PATCH |
| Doc fix, internal refactor with no surface change       | PATCH |
| Dependency bump with no surface change                  | PATCH |

An error `code` is contract; an error `message` is not — **BACKGROUND:**
`designing-errors` explains why that split exists and how the two fields are used.

When a change spans more than one row (say, an added export alongside a narrowed input
elsewhere), the level is the highest row it touches — MAJOR outranks MINOR outranks
PATCH for the same PR.

Decide the level from the table first, then apply the version this package is actually
on. While it is below `1.0.0`, a MAJOR change ships as a minor bump and **must** carry
migration instructions for consumers; after `1.0.0` it ships as a major bump. Read the
current version from `package.json` rather than assuming which period applies — the note
still names the level the table gave, so the reviewer sees the breaking change rather
than a minor bump that hides one.

## There is no CHANGELOG.md

This repository publishes nothing, and it keeps no changelog: the file went with the
publish gates. The `Release impact:` line in the pull request body is the whole record,
so write it in terms of observable behavior rather than which files changed. Do not
recreate `CHANGELOG.md` as a side effect of a feature PR.

## Done when

- `pnpm run check:source` is green — this proves the surface builds and is tested, but
  proves nothing about intent.
- The PR body carries either a release-impact note (`yes` with a level and reason) or an
  explicit `no` statement, per the section above.
- Publishing itself is not part of this checklist: AGENTS.md gates commit, push, PR, and
  publish behind a human.
