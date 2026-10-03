# A new private repository

Decide availability before the new app's first PR merges. The dependency review action
works in public repositories and in private repositories with GitHub Code Security or
GitHub Advanced Security enabled
([GitHub dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review),
checked 2026-10-02). GitHub code scanning in private repositories needs a GitHub Code
Security license; its availability also depends on repository ownership and plan
([GitHub code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning),
checked 2026-10-02).

1. **Human:** confirm the new repository's visibility, plan, and enabled security
   features. Choose the licensed checks or concrete replacement protections before
   asking an agent to change any security gate. Silence or a failing run supplies no
   approval to delete it.
2. **Agent, after that decision:** if the chosen private repository cannot run them,
   delete or replace `.github/workflows/dependency-review.yml` and
   `.github/workflows/codeql.yml` as the approved plan specifies. Preserve dependency
   vulnerability/license review and source-security analysis through the chosen
   replacements; do not remove a check merely to make CI green.
3. **Agent:** update the exact workflow and writer inventories in
   `tests/workflows.test.ts`, and reconcile `.github/rulesets/main.json` with jobs that
   actually existed as required PR contexts. Replace `Review new dependencies` when
   removing that job. CodeQL currently runs on default-branch pushes and a schedule, so
   it has no required PR context to remove from this template's ruleset. Keep other
   contexts unchanged and run the workflow, ruleset, and source gates.
4. **Human:** apply the approved new repository's live ruleset with `pnpm repo:ruleset`
   before merging a PR that renames or drops an existing required context.
   `changing-gates` owns that timing. The agent prepares the files and evidence; the
   owner performs the settings write.

This procedure is for an app started from the template. It does not alter the public
template's workflows or authorize a licensing purchase or a remote settings change.
