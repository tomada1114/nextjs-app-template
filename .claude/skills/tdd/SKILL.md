---
name: tdd
description: >
  Use when changing behavior under src/ - adding a function, a handler branch or a
  component state, or fixing a bug - to settle the order of work: which zone the code
  goes in, the failing test before the implementation, proving with pnpm exec vitest run
  that it fails for the right reason, the smallest change that turns it green,
  refactoring with the gates on, the regression test a bug fix starts from, and landing
  test and code in one commit. Also when a test written after the code only restates
  what the code does.
---

# Test-Driven Development

**Owns:** the order of work on a behavior change under `src/` — where the code goes, the
failing test before it, the proof that the test fails, the smallest change that passes,
the refactor, and the commit. **Does not own:** how a test case is written
(`writing-tests`); which file and vitest project it joins and which coverage floor
governs it (`placing-tests`); compile-time assertions (`type-testing`); which file a
page, layout or handler is (`building-app-routes`); what `src/core/` may not read
(`writing-typescript`); the map from a changed path to its check (AGENTS.md's
"Validating a change").

A test written after the code asserts whatever the code happens to do. It passes on its
first run, so nothing ever showed that it can fail, and every gate is green over a test
that cannot tell right from wrong. Writing it first, and watching it fail, is the cheap
way to know it can.

A change with no behavior — a rename, a comment, a format — needs no new test; the suite
that already covers the code is its check.

## Where the code lives

Decide this before the test: the zone decides which interface the test drives. The zones
and the direction imports run in are AGENTS.md's "Architecture"; this is only what each
means for the order of work.

- **A decision** — a rule, a calculation, a state transition — goes in `src/core/`. It
  is framework-free, tested by calling it, and counted against the `src/` coverage
  floor. **REQUIRED:** `writing-typescript`'s "Core logic" for what core is handed
  rather than reads.
- **A handler** under `src/server/handlers/` stays a thin Web-standard function: parse
  the request, call core, map the result to a `Response`. A branch that decides
  something moves down into core, where its test needs no `Request` at all.
- **A component** renders what it is handed. Logic that chooses what to show is a value
  core computes and the component receives as a prop.
- **A page, layout or Route Handler** under `src/app/` — **REQUIRED:**
  `building-app-routes` for which file it is and what moves out of it.

The test follows the zone: call the core function, send a `new Request(…)` into the
handler factory, render the component under jsdom.

## Red: the test first

- Write the test for the behavior a caller observes, through the zone's surface, before
  touching `src/`. **REQUIRED:** `writing-tests` for the body, `placing-tests` for the
  file and its project.
- Write the edge cases now, as `it.each` rows. A case added after green is written
  against what the code returns, which is the failure this order exists to prevent.
- One behavior per cycle. A batch of tests followed by a batch of code leaves no single
  red to attribute to a single change.
- A changed exported type is asserted with `expectTypeOf` or `@ts-expect-error` —
  **REQUIRED:** `type-testing`. Its red shows in `pnpm check:quick`'s type check, never
  in `vitest run`, which does not type-check.

## Prove it fails, for the right reason

Run the one file — `pnpm exec vitest run tests/<name>.test.ts`, or `.test.tsx` for a
component — and read the failure. Red alone is not the proof; the reason is.

| The run reports                                                          | Counts as red                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `TypeError: <name> is not a function`, naming the export not yet written | yes, for a function that does not exist yet                    |
| the new assertion itself, expected against received                      | yes, and the only red that counts for a behavior change        |
| a syntax error, a typo in the test, a fixture or setup error             | no — fix the test and run again                                |
| `Cannot find module`, with `0 test` collected                            | no — create the module file first, so the run reaches the test |
| green                                                                    | no — the test does not cover the change; rewrite it first      |

A module that does not exist yet fails the whole file before any `it()` is collected
(observed with `pnpm exec vitest run`, Vitest 4.1, 2026-10-01), so that run proves only
the import path. An empty module is enough to turn it into the `TypeError` above.

Never skip this run, even when the failure looks certain. A test that has never failed
has proven nothing.

## Green: the smallest change that passes

- Write only what the failing test demands. A branch no test asks for waits for the test
  that does.
- Re-run the file until it passes, then `pnpm test` for whatever else the change
  reached.
- Green reached by editing the test is not green. An assertion changes only when the
  expectation itself was wrong, and the pull request says so.

## Refactor with the gates on

With the tests green, restructure — rename, extract into core, remove duplication —
without changing behavior, re-running the file after each step. A refactor that needs a
test edited has changed behavior; that is a new red, not a refactor.

Then widen the check from the one file to the narrowest one for what changed. The row
for an exact path is in AGENTS.md's "Validating a change", which wins wherever this
summary disagrees with it:

| What changed                                                       | Run                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| A module with an in-process test — core, server, i18n, a component | `pnpm exec vitest run tests/<name>.test.ts` (or `.tsx`) |
| An import that crosses a zone boundary                             | `pnpm exec vitest run tests/boundaries.test.ts`         |
| Anything only a running server shows — a page, a layout, styles    | `pnpm build`, then `pnpm test:smoke`                    |
| Any of the above, before the commit                                | `pnpm check:quick`                                      |
| A new file under a coverage floor, or before the pull request      | `pnpm test:coverage`, then `pnpm check:source`          |

## Fixing a bug

The regression test comes before the fix, and it reproduces the bug through the
interface the caller hit — not through a helper the bug happened to pass through.

1. Write the test the way the caller met the bug: `new Request(…)` into the handler
   factory for a wrong response, the component rendered under jsdom for wrong output,
   the core function called directly for a wrong value. Name it after the behavior, not
   the report.
2. Prove it fails with the bug's own symptom — the wrong status, the wrong text, the
   wrong value — not with any error at all.
3. What only a running server shows reproduces through `pnpm build && pnpm test:smoke`.
   A new smoke case is a claim that no in-process test could assert the same thing —
   **REQUIRED:** `placing-tests` before adding one.
4. Then green and refactor as above. The regression test stays.

## Commit

Test and implementation land in one commit. A test-only commit is red: lefthook's
pre-commit hook runs the tests related to the staged files and refuses it. An
implementation-only commit puts untested behavior on the branch, and the test that
follows it in a later commit can no longer be shown to have failed.

## Anti-patterns

- Implementation first, then a test that asserts what the code returned.
- Weakening or deleting an assertion to reach green, or replacing an expected value with
  whatever the code produced.
- `it.skip` or `it.todo` for a case that does not pass yet — **BACKGROUND:**
  `writing-tests`'s "Independence", and the lint rule that refuses both.
- Asserting a private helper's call count instead of the behavior it serves —
  **BACKGROUND:** `writing-tests`'s "Fakes over mocks".
- A real sleep to wait out a timer instead of `vi.useFakeTimers` — **BACKGROUND:**
  `writing-tests`'s "Fake timers".
- Skipping the failing run because the failure was obvious.
