# The pre-commit hook

Read when `git commit` fails, or before committing a partially staged file. The jobs and
their globs are `lefthook.yml`'s; read it there, not here — this file holds only what
each refusal means and how to clear it without switching the job off.

## How the hook runs

- `format` runs first and alone. It **rewrites** staged files with Prettier and
  re-stages them, so the commit can differ from what you staged — and when a later job
  fails, the index keeps those rewrites.
- `eslint`, `typecheck`, `test:related`, `check:staged` and `agents:check` then run in
  parallel. One failure aborts the commit; read every job's output, since more than one
  can fail at once.
- `eslint` and `typecheck` run only when a code file is staged; `agents:check` only when
  a path under `.agents/skills/` or `.claude/skills/` is.
- On the commit that concludes a merge, or a `git commit` at a rebase stop, `format`,
  `eslint`, `typecheck` and `test:related` are skipped; `check:staged` and
  `agents:check` still run. `git rebase --continue` runs no pre-commit job at all.
- `typecheck` and `test:related` read files on disk. A file you left out of the commit
  is still there, so it can be what fails them — or what a passing run silently depended
  on.

## Recovery, one row per job

| Job            | What the failure means                                                                                                                                                                                                                                                                             | Clear it by                                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`       | Prettier could not parse a staged file, or a partially staged file had an unstaged hunk overlapping a line Prettier rewrote — that aborts the whole commit, worktree recovered, index left unformatted. A run that only rewrote files is not a failure; `git diff --cached` shows what it changed. | A parse error: fix the syntax. An overlap: stage the whole file; or run `pnpm exec prettier --write <file>` first and stage the hunks again; or `git stash push --keep-index`, commit, and `git stash pop`, resolving by hand a pop that conflicts on a reformatted line. |
| `eslint`       | A lint violation survived formatting. The job runs without `--fix` on purpose.                                                                                                                                                                                                                     | `pnpm fix`, or a fix by hand; then `git status --short`, because `pnpm fix` runs over the whole tree, and re-stage only this group's paths by name. Never an `eslint-disable` and never a relaxed rule.                                                                   |
| `typecheck`    | The whole program failed to type-check, not only the staged files. The error can sit in a file this commit does not touch, or in an unstaged edit.                                                                                                                                                 | Fix the type where it is. When it lives in an unstaged change that belongs to this group, stage it; when it belongs to a later group, set it aside with `git stash push --keep-index` and commit. Never `@ts-ignore`, `@ts-expect-error` or a cast to silence it.         |
| `test:related` | A test reachable from the staged files fails — often a test staged without the code it covers, or the reverse.                                                                                                                                                                                     | Reproduce with `pnpm exec vitest run tests/<name>.test.ts`, then fix the code or the test, or stage the half that was left out. Never `.skip`, `.todo`, a deleted test or a weakened assertion. **BACKGROUND:** `tdd`.                                                    |
| `check:staged` | One `Blocked: <reason>` line per refused path: a secret-shaped path, a private-key file, or a credential in a staged file's content.                                                                                                                                                               | `git restore --staged <path>`, then tell the requester which path was refused and why — without opening it. Never edit `scripts/check-staged.mjs` or `scripts/lib/guard/` to let it through; a refusal you believe is wrong is a stop for a human to judge.               |
| `agents:check` | `ERR_AGENTS_DRIFT`: `.claude/skills/` is not a byte-for-byte copy of `.agents/skills/`.                                                                                                                                                                                                            | Make the edit under `.agents/skills/` (an edit made only under `.claude/skills/` is lost at the next sync, so move it first), run `pnpm agents:sync`, and stage both `.agents/skills/<name>/` and `.claude/skills/<name>/`. **BACKGROUND:** `authoring-skills`.           |

After the fix, rerun the same `git commit`. Every job runs again, so a fix for one row
can surface another.

## What never clears a refusal

`git commit --no-verify` or `-n`, `LEFTHOOK=0` or any other environment switch that
turns a job off, an edit to `lefthook.yml`, and `git rebase --continue` used to commit
past the hook. Each removes the check rather than the problem, and `--no-verify` takes
the secret guard down with everything else. A refusal that cannot be cleared is
reported, with the failing job's output, and the commit waits for a human.
