# Landing outcomes

What `land_pr.sh` can return and what each result requires. Read it when the merge step
returns anything other than a clean merge.

`land_pr.sh <pr> --issue <n>` prints two lines — `result:` and `issue:`. The `--issue`
flag makes it re-check the closing link before merging and confirm the issue really
closed after, closing it explicitly with a back-reference comment if GitHub's auto-close
did not fire.

This skill never passes `--auto`. Arming auto-merge hands the merge to GitHub after this
run has stopped watching, while the go-ahead this skill merges on is a `verdict: PASS`
from `ci_watch.sh`. A PR that waits on a human review is held and reported, not armed.

| `result:`                                                                                                                                                             | What it means                                                              | What to do                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_LINKED` / `WRONG_BASE`                                                                                                                                           | the script refused to merge because the issue would be orphaned            | repair it — `link_check.sh --fix` for a missing keyword, retarget the PR's base for a wrong base — then retry. Pass `--no-link-check` only if the user asked for a PR that deliberately does not close its issue. |
| `DRAFT`                                                                                                                                                               | still a draft, and the script could not (or was told not to) mark it ready | mark the PR ready, then retry.                                                                                                                                                                                    |
| `reviewDecision: REVIEW_REQUIRED` or `mergeStateStatus: BLOCKED` in the JSON it echoes (the same two facts `ci_watch.sh` prints as `review_decision` / `merge_state`) | a human review gate, not a failing check                                   | record `--event blocked --field reason=review-required`, report the PR as held for a human review, and move on to the next issue.                                                                                 |
| `MERGE_REFUSED` / conflicts                                                                                                                                           | the merge itself was rejected                                              | report the reason; for conflicts, [bring the branch up to date](#bringing-a-pushed-branch-up-to-date) and return to the CI step.                                                                                  |
| `ALREADY_MERGED` / `NOT_OPEN`                                                                                                                                         | the PR left the open set before this call                                  | take the issue's state from the `issue:` line and move on without retrying.                                                                                                                                       |
| `MERGE_UNCONFIRMED` / `ERROR`                                                                                                                                         | the outcome is unestablished                                               | re-read the actual PR and issue state. **Never report a merge on this result alone.**                                                                                                                             |

## Bringing a pushed branch up to date

A PR branch has already been pushed, so it is brought up to date by merging the default
branch into it, never by a rebase: a rebased branch needs a force-push, which the
sign-off for this skill does not cover (`AGENTS.md` › "Security and human approval").

```bash
git -C <workdir> fetch origin <default_branch> --quiet
git -C <workdir> merge origin/<default_branch>
git -C <workdir> push
```

A conflict is `recovery.md`'s "A merge conflict". A repository whose rules require
linear history and refuse this merge is a stop condition: record
`--event blocked --field reason=linear-history` and ask the human.
