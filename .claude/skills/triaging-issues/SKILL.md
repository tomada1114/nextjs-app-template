---
name: triaging-issues
description: >
  Covers this repository's issue vocabulary: the labels in .github/labels.yml, what
  `blocked: design`, `blocked: dependency`, `blocked: external`, `on hold`, and
  `tracking` mean, and what an issue body must contain (a `path:line`, an observable
  close condition, a `Depends on: #N` line). Use when filing an issue, triaging or
  re-prioritizing the backlog, picking a `priority: P0`-`P3` label, choosing between
  `bug`/`enhancement`/`documentation`/`chore`/`security`, marking a tracking issue,
  running `pnpm repo:labels`, recording a problem found outside the task, or routing a
  daily-use request.
---

# Triaging Issues

**Owns:** this repository's issue vocabulary — the label taxonomy, what a priority
means, and what an issue body must contain. **Does not own:** implementing an issue; any
workflow beyond the tracker.

Labels carry the triage decision, so it is made once and read back rather than
re-derived every time the backlog is looked at. An issue is filed with a type label and
left untiered; triage adds the priority.

## Priority labels

| Label                 | When to apply it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority: P0`        | Reserve for a real blocking chain — another open issue names it as the blocker — or active damage (red main, a live vulnerability). Don't tier by how urgent an issue feels; tier by whether something is actually blocked or broken.                                                                                                                                                                                                                                                                                                                                 |
| `priority: P1`        | Foundational work — CI, schema, shared types, config — future issues will build on, even before any open issue names it as a dependency. Once one does, the resulting blocking chain likely makes it P0 instead of P1.                                                                                                                                                                                                                                                                                                                                                |
| `priority: P2`        | The default tier, used absent a specific reason to move up or down. Before leaving something here, check whether it actually blocks an open issue (P0) or is groundwork later issues will need (P1) — P2 is not a place to park work you haven't evaluated.                                                                                                                                                                                                                                                                                                           |
| `priority: P3`        | Defer only when impact is genuinely low — nobody is waiting on it and no future issue depends on it. Not a stand-in for "I don't want to do this"; an issue that matters but is unappealing to implement belongs at its real tier.                                                                                                                                                                                                                                                                                                                                    |
| `blocked: design`     | Applies when the approach has real, unresolved alternatives a human must choose between — not simply that no one has looked at it yet. It still gets a priority tier (see below); readiness and priority are independent judgments.                                                                                                                                                                                                                                                                                                                                   |
| `blocked: dependency` | Applies only alongside a `Depends on: #N` line in the body (see Ordering constraints below) — the label without a named blocker can't be verified or cleared automatically.                                                                                                                                                                                                                                                                                                                                                                                           |
| `blocked: external`   | A step only a person can take: signing in to a provider's console as the account owner or registering an MFA device, a purchase, a paid plan or a billing change, accepting legal terms, a DNS change at a registrar the agent cannot reach, or a credential only the owner holds. Not for anything an agent can do with its own tools — code, a CLI with configured credentials, an MCP server, or `gh`. Put the agent-doable remainder in its own issue when it is large. Automated shipping never picks the issue up. Clear the label once the human step is done. |
| `on hold`             | Real work parked on purpose, with the reason in a comment. It keeps its tier; automated shipping never picks it up. Distinct from `blocked: design`: there the block is a decision still pending inside the tracker; here there may be no in-tracker decision to make at all. Not for a tracking issue — that is `tracking` (below).                                                                                                                                                                                                                                  |

Priority ranks impact on the rest of the backlog, not how interesting the work is. Do
not tier an issue by how appealing it is to implement.

Tier and design-readiness are independent: an issue carrying `blocked: design` still
gets a tier, so it ranks correctly the moment the block clears. Never leave a
`blocked: design` issue untiered on the assumption that the tier can wait — it cannot be
re-derived later without redoing the judgement.

`tracking` marks a tracking issue: a checklist of sub-issues — native sub-issues or
`- [ ] #N` lines — whose own body is never implemented. It takes a type label (usually
`chore`) and no tier, since it ranks nothing; each sub-issue carries its own tier.
`shipping-issues` drops a `tracking` issue before ranking, so it is never selected and
never offered a tier to backfill. A parent that still carries `on hold` from before this
label existed is relabelled `tracking`.

A label that turns out to be wrong gets corrected, not worked around. Ranking around a
stale label in your head leaves the next reader to make the same mistake — fix the label
instead of mentally overriding it.

## Type labels

`bug`, `enhancement`, `documentation`, `chore`, and `security`. Only the first three are
GitHub defaults, so `chore` and `security` have to exist in the repository before the
forms under `.github/ISSUE_TEMPLATE/` can apply them — GitHub silently drops a label the
repository does not have, rather than reporting one. Run `pnpm repo:labels` to create or
update every label in the repository from `.github/labels.yml` before relying on a form
that applies `chore` or `security`.

`.github/labels.yml` is the source for the label set itself — name, color, and
description; this skill holds only what each one _means_ for triage.
`.github/ISSUE_TEMPLATE/*.yml` is what applies a type label at filing time. Two labels
in `.github/labels.yml` — `dependencies` and `ci` — are PR-only, applied by
`.github/workflows/pr-label.yml` from a PR's Conventional Commit type, and are never
used for issue triage. If the file and this skill disagree about a triage label, fix the
mismatch rather than choosing one.

`security` marks a security-relevant defect that is safe to discuss in public: a
hardening gap, a missing defense layer, a follow-up to an advisory already fixed and
published. A vulnerability someone could exploit today is never a public issue, a pull
request description, or a comment: it goes through `SECURITY.md`'s private advisory
route, which `.github/ISSUE_TEMPLATE/config.yml` links from the issue chooser. When
unsure which it is, it is the private route.

## What an issue body must contain

Two things belong in the body because nothing else can recover them later:

- **What is wrong today**, with a `path:line`. A description of a symptom without a
  location forces whoever picks up the issue to re-find what the filer already knew.
- **What observable result closes it**, named as a test or a command — not as a feeling
  of doneness ("works correctly", "is cleaned up"). A closing condition that cannot be
  checked mechanically cannot be verified by anyone but the filer.

## Ordering constraints

Write an ordering constraint as `Depends on: #12` — this is the spelling automation
parses. Prose like "after the guard work lands" is not machine-readable and will not be
picked up.

An issue carrying a `Depends on:` line also carries `blocked: dependency`. The label is
**not** removed automatically when the blocker closes: whoever lands the blocking issue
clears `blocked: dependency` by hand from every issue that named it. Do not assume the
label update is someone else's automated job — it is a manual step in the same PR or a
prompt follow-up that closes the blocker.

## A problem found outside the task

`AGENTS.md` › "Conventions" says an improvement spotted outside the current scope is
noted, not made. Noting it means an issue with a type label, a `path:line`, and a close
condition, exactly as "What an issue body must contain" asks. Filing is a remote write:
it is yours only under a skill that lists it (`shipping-issues` files its own
follow-ups) or when the owner asked for the issue. Otherwise draft the title, labels,
and body in the reply and wait for a yes, or — where filing is not yours to do at all —
list the finding in the pull request description. Never widen the pull request to fix
it. A finding that is an exploitable vulnerability takes the private route under "Type
labels" instead, never an issue or a pull request description.

## Requests from daily use

A friction or an idea that comes up while using the app is routed the moment it is
raised, so it is neither lost in a chat log nor shipped unreviewed. The owner explicitly
asking for an issue is the sign-off for creating each issue that request asks for
(`AGENTS.md` › "Standing exceptions"). A friction the owner mentions without asking for
an issue, like one you noticed yourself, is drafted in the reply — title, labels, body —
and waits for a yes. Either way, pick one outcome:

1. **File it** when it stays inside the existing design and is in scope for the product
   `AGENTS.md` describes. It gets a type label, a tier (`priority: P2` unless the table
   above says otherwise), and a body that meets "What an issue body must contain".
   Several requests in one message get one issue each, unless they are one pull
   request's worth. Report the numbers and stop; implementation waits until someone
   picks the issue up.
2. **Park it** as `on hold` when it is worth keeping but not worth doing yet: it needs
   more use to judge, or it leans on something `AGENTS.md` rules out of scope. File it
   the same way, add `on hold`, and comment the reason and what would change the call.
   It keeps its tier. One that is wanted now but waits on a choice between real
   alternatives is filed with `blocked: design` instead.
3. **Drop it** without an issue when it contradicts the product's stated scope or
   duplicates an open issue. Say so in the reply, with the reason, so the decision is
   visible rather than silent; a comment on the duplicate is drafted, not posted, unless
   the request covered it.

A parked issue leaves the lane by a decision, never by age:

- **Promote** it by removing `on hold` once its reason no longer holds: the use it
  waited for happened, or the decision it needed was made. Re-check its tier; if a real
  choice remains, it may now want `blocked: design` instead.
- **Close** it as not planned when its reason became permanent: the app moved away from
  it, or a later issue superseded it (link that one).

Moving the product's scope to admit a request is the owner's call, not the triager's:
parking or dropping it records that line rather than crossing it.
