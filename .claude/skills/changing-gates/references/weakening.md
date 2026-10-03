# Assessing a gate change

AGENTS.md's prohibition on weakening a gate holds even while the task is to make CI
green. This table explains the protection a reviewer must assess; it grants no
exception. Read the actual config for its values.

| Gate                                 | A weakening to reject                                                                       | Why it matters                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Workflow permissions and Action pins | Wider write scopes without a reviewed need, floating tags, persisted checkout credentials   | A compromised action gains more authority or its source can move without a reviewed diff.                       |
| Workflow execution                   | Removing timeouts, push history, or fail-closed shell handling                              | A hung job or an ignored failure can erase evidence or consume resources indefinitely.                          |
| Dependency install                   | Dropping `--frozen-lockfile`, supply-chain checks, or the Node runtime failure policy       | The checked graph or runtime can differ from the committed and reviewed one.                                    |
| Required checks                      | Renaming, filtering, or deleting a required job without reconciling its context             | The live ruleset can wait forever or cease to enforce the intended gate.                                        |
| Pre-commit                           | Bypassing hooks, narrowing the staged guard's paths, or running it before formatting        | An unchecked staged blob can reach history; a check of the earlier blob proves nothing about the committed one. |
| Lint and types                       | Removing a boundary, hiding an error, or broadening an exception to silence it              | The architecture or type guarantee becomes advisory at the exact site that needs it.                            |
| Coverage and tests                   | Lowering floors, excluding source to lift a percentage, skipping or deleting a failing case | Green stops meaning that the protected behavior was checked.                                                    |
| Skill mirror                         | Editing the generated tree or bypassing `agents:check`                                      | The two hosts can execute different instructions.                                                               |

A protection that no longer applies is a human decision, explained in the PR with the
trigger, affected files, and replacement evidence. Fix the cause of a failing gate
first. The [per-file guide](gate-files.md) owns the mechanics; the
[required-check guide](required-checks.md) owns committed and live context timing.
