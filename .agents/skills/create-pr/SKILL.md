---
name: create-pr
description: >-
  Use when opening or updating a pull request by hand, outside shipping-issues: asked to
  "open a PR", "create a pull request", "push this and make a PR", or to refresh the
  title or body of the PR already open for the current branch. Covers the preconditions
  (not on the default branch, a clean tree, one PR per branch), running pnpm
  check:source first, a title check-pr-title.yml accepts, filling
  .github/PULL_REQUEST_TEMPLATE.md's Summary, Test Plan and Checklist honestly, and git
  push, gh pr create and gh pr edit.
---

# Create PR

**Owns:** opening a pull request for the current branch, or updating the one already
open for it — the preconditions, the gate run before it, the title, the body, and the
push. **Does not own:** shipping an issue end to end through CI and merge
(`shipping-issues`); landing a bot PR (`merge-dependabot`); making the commits the PR
carries.

**Invoking this skill is the sign-off for exactly these remote writes, for this
invocation only:** pushing the current branch to `origin`, `gh pr create` for it, and
`gh pr edit` on its own open pull request. Nothing else — no force-push, no merge, no
label, no comment, no other branch. A step that would need one of those stops and asks
(AGENTS.md's "Standing exceptions").

Every step below ends in either the next step or a stop. A stop is reported with what
was found and what would clear it; it never becomes a PR with the problem left in it.

## 1. Preconditions

Gather the state before running anything:

```bash
git branch --show-current
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name   # <default>
git status --short
git fetch origin <default>
git log --oneline origin/<default>..HEAD
gh pr list --head <branch> --state open --json number,url,title
```

- **On the default branch, or detached:** stop. A PR needs a branch of its own, and
  creating one is the requester's call.
- **Uncommitted or untracked changes:** stop. The PR would carry only what is committed,
  so the gate would judge a tree the reviewer never sees. Commit first with
  `smart-commit` — a commit needs its own sign-off, the request that invokes that skill,
  which this skill does not grant — then start again.
- **No commits ahead of the default branch:** stop; there is nothing to propose.
- **A PR already open for the branch:** update it in step 6 with `gh pr edit`. Never
  open a second PR for the same branch — the first one's review and CI history would be
  stranded on a duplicate.

## 2. The gate

Run `pnpm check:source`, the full gate CI runs. It includes `next build` and the skill
script tests, so it can outlast a foreground command timeout: on a host that can run a
command in the background and report back when it exits, run it that way and wait for
the report; otherwise give the call a timeout that covers a full build. Never poll it
with a hand-rolled sleep loop.

- **Any failure stops the PR.** Fix it on the branch, or report it. Never weaken a gate
  to make the run pass (AGENTS.md's "Security and human approval").
- **Then `git status --short` again.** Anything the gate rewrote — a formatted file, a
  regenerated `next-env.d.ts` — means the branch differs from what was just judged.
  Commit it (with the sign-off step 1 names) and run the gate again; a PR is opened only
  from a tree the gate passed unchanged.

Also run the narrowest check for what the branch touches, from AGENTS.md's "Validating a
change" table, when the gate does not already run it — `pnpm agents:check` for a skill,
for instance. The Test Plan names both.

## 3. Read the diff for what the gates cannot judge

```bash
git diff origin/<default>...HEAD --stat
git diff origin/<default>...HEAD
```

Read it for the things no gate decides. Each feeds a checklist item or the Summary:

| In the diff                                                            | Then                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new environment variable                                             | It is in `.env.example` and validated in `src/server/env.ts`, or the checklist item does not hold.                                                  |
| A new UI string                                                        | It is in every catalog under `messages/`, or the item does not hold. **BACKGROUND:** `localizing-ui`.                                               |
| A new entry in `package.json`'s dependencies                           | Stop unless a human already signed off on that package in this session; then state its reason in the body. **BACKGROUND:** `managing-dependencies`. |
| A weakened gate (AGENTS.md's list: an `eslint-disable`, …)             | Stop. The PR waits until a human decides; it is not opened with the item unticked.                                                                  |
| A contract change (AGENTS.md's "What is contract and what is private") | Name it in the Summary, in one line a caller can act on. An `ERR_*` code: **REQUIRED:** `designing-errors` for that line.                           |
| A change that owes a document                                          | The document is changed on this branch, or the PR stops. **REQUIRED:** `updating-docs` decides whether one is owed.                                 |

A row that does not apply to the diff holds trivially; say so in the body rather than
leaving the reader to guess ("No new environment variable").

## 4. Title

`<type>(<scope>): <summary>`, under 72 characters, in English. The type is one of the
`types:` list in `.github/workflows/check-pr-title.yml` — read it there, it is the one
the check enforces. The title becomes the squash-merge commit subject, and
`.github/workflows/pr-label.yml` derives the PR's label from its type, so the type is
not decoration.

- The scope is the area the change lives in, matching the repository's recent history
  (`git log --format=%s -20`): `skills`, `agents`, `hooks`, `deps`, a zone name.
- The summary is imperative and lower-case, with no trailing period, and says what the
  change does, not which files it touches.
- For a branch whose commits mix types, take the most significant one: `feat` over `fix`
  over the rest.

## 5. Body

Fill `.github/PULL_REQUEST_TEMPLATE.md` in its own order, keeping its headings, and
write it to a file outside the checkout — the scratch or temp directory your host
provides — so it never shows up as an untracked file in the tree the gate judged.

- **Summary.** One or two lines: what the change does and why, then the contract or
  dependency line step 3 called for. Then `Closes #N` on its own line when the branch
  resolves an issue; a bare `#N` closes nothing. Ask rather than guess when it is
  unclear which issue the branch closes.
- **Test Plan.** The commands actually run, each with what it printed, summarized to the
  verdict line — `pnpm check:source` → passed, `Tests  N passed`. Never a command that
  was not run, and never a raw log.
- **Checklist.** Tick an item only when step 2 or step 3 showed it holds. An item that
  cannot be ticked is a stop: report which one and why, and open nothing. A box ticked
  on trust is the one defect in this PR a reviewer cannot see.

## 6. Create or update

```bash
git push -u origin <branch>
gh pr create --base <default> --head <branch> --title "<title>" --body-file <body-file>
```

For a branch that already has an open PR, push, then update that PR instead:

```bash
gh pr view <number> --json title,body
gh pr edit <number> --title "<title>" --body-file <body-file>
```

Read the current body first and carry over anything a human added to it — `gh pr edit`
replaces the body whole.

- A push rejected as non-fast-forward stops: the remote branch has commits this checkout
  does not. Never force-push to get past it.
- `--body-file`, never an inline `--body` built from a heredoc or command substitution —
  backticks and `$` in a body are expanded by the shell before `gh` sees them.
- Run no `--web` flag or anything else that opens a browser; print the PR's URL instead.

Report the URL, the title, and every checklist item as it was ticked. The PR is then the
requester's: watching CI and merging are not this skill's.
