---
name: writing-repo-scripts
description: >
  Use when adding, writing or editing a .mjs under scripts/** or scripts/lib/**, a
  script that writes to GitHub through gh, or when repository automation misbehaves
  under a git hook: an inherited GIT_DIR or GIT_INDEX_FILE making a spawned git write to
  the wrong repository despite a cwd or -C (isolatedGitEnv), a lefthook pre-commit
  failure, importing anything outside node:* builtins, JSDoc boundary types under
  allowJs/checkJs, narrowing JSON.parse through scripts/lib/json.mjs, the
  import.meta.main CLI guard, or how a script must report failure on stderr with an
  ERR_<STAGE>_* code.
---

# Writing Repository Scripts

**Owns:** the authoring contract for `scripts/**/*.mjs` — imports, typing, git safety,
the stderr contract, and every place a new script must reach. **Does not own:**
authoring a skill or mirroring it into `.claude/skills/` (`authoring-skills`); where a
script's tests live and its coverage floor (`placing-tests`); the `ERR_<STAGE>_*` code
vocabulary shared with `src/` (`designing-errors`); wiring a script into a gate
(`changing-gates`).

## Why `.mjs`, not `.ts`

- `scripts/**` must run on a plain Node **before** `pnpm install` has been run, so it
  cannot depend on a compile step or on anything installed. Author it as `.mjs`.
- Import only `node:*` builtins and the shared helpers under `scripts/lib/`. Never
  import a dependency from `node_modules` directly — a script that needs an installed
  tool spawns it at run time instead, so the script still loads even when that
  dependency is absent. No script does today, and no helper resolves a dependency's bin
  any more, so a script that needs one has to locate it and hand the path to `runNode`
  (`scripts/lib/node-tools.mjs`) itself.
- Import Node globals explicitly (`import process from "node:process"`,
  `import console from "node:console"`) rather than relying on the ambient globals Node
  provides at the top level.

## Typing under `allowJs`/`checkJs`

Enforced by: `tsconfig.json`'s `allowJs`/`checkJs` and the `scripts` include entry; the
automation/node-scripts block in `eslint.config.mjs`.

- These files are type-checked exactly like a `.ts` module. Declare boundary types in
  JSDoc (`@param`, `@returns`, `@typedef`) with the same rigor as a TypeScript signature
  — an untyped parameter here is as much a gap as one in `src/`.
- Receive `JSON.parse` output as `unknown` and narrow it through `readKey`/`readString`
  in `scripts/lib/json.mjs`, never a direct cast. `noPropertyAccessFromIndexSignature`
  and the typed-lint `dot-notation` rule disagree about literal-key access on a
  `Record`, so reads go through these helpers instead of picking one style and tripping
  the other.

```js
import { parseJson, readString } from "./lib/json.mjs";

const manifest = parseJson(readFileSync(manifestPath, "utf8"));
const name = readString(manifest, "name");
```

## The CLI guard

A file that is both importable (from a test) and runnable as a command guards its CLI
half with Node's own `import.meta.main`, so importing it for a test never triggers a
run.

```js
if (import.meta.main) {
  await main(process.argv.slice(2));
}
```

The property is true only for the module Node was started with, and Node resolves that
entry through symlinks — a script reached through a `node_modules/.bin` shim still
reports true, while a module the entry merely imports reports false, and so does every
script a test imports. `import.meta.url.endsWith("foo.mjs")` is true in both cases and
cannot make that distinction, so do not reach for it. Neither wrap the property in a
shared helper: a helper can only ever see the `import.meta.url` its caller hands it,
never its caller's `import.meta.main`, so it buys indirection and no reach.
`@types/node` declares `main` on `ImportMeta`, so `checkJs` accepts the property and a
mistyped one still fails as `TS2339`.

## Spawning `git`

Git exports `GIT_DIR` to every hook it runs, and `git commit -- <path>` also exports a
temporary `GIT_INDEX_FILE`; `lefthook.yml` runs this suite from its own pre-commit hook.
An inherited `GIT_DIR` **outranks** both a `cwd` and an explicit `-C` — a `git` spawned
with only a `cwd` writes to the outer repository's index and object store, not the one
the caller meant.

Any `git` invocation that names the repository it means must clear `GIT_*` first, with
`isolatedGitEnv` from `scripts/lib/git-env.mjs`:

```js
import { isolatedGitEnv } from "./lib/git-env.mjs";

spawnSync("git", ["init", "-q"], { cwd: fixtureDir, env: isolatedGitEnv() });
```

The one exception is `scripts/check-staged.mjs`, which **is** the pre-commit layer and
must read the index that hook was given, so it inherits `GIT_*` deliberately. Its own
tests clear the variables from their own process with `vi.stubEnv` instead of routing
through `isolatedGitEnv`.

## Outside a git work tree: refuse or skip

A script run where there is no repository — a tarball extract, a Docker build context, a
copy inside somebody else's checkout — either refuses or skips, and its header comment
says which:

- **Refuse**, non-zero with a named `ERR_*` code, when the job is defined over the
  repository. `scripts/check-staged.mjs` has no index to read there, and a silent pass
  would be a commit nobody checked.
- **Skip**, with a one-line notice on stderr and exit 0, when the question is
  meaningless there. `scripts/verify-hooks.mjs` runs from `prepare`, and failing
  `pnpm install` in a build context would cost more than the missing answer.

A skip fires only on git's own "not a repository" answer. A `git` that could not run at
all, or refused for `safe.directory`, still fails — `verify-hooks.mjs` reports
`ERR_HOOKS_GIT_UNAVAILABLE` instead of assuming the work tree is absent.

## The stderr contract

An error raised by automation is read by an agent, not a human watching a terminal, so
it must say: what failed, the path or export involved, expected versus actual, an error
code, and the next safe command to run — and never a secret or an absolute home path.
**REQUIRED:** `designing-errors` for the `ERR_<STAGE>_*` code vocabulary a new script's
errors should join.

Worked example, the report `scripts/sync-agents.mjs` prints when `pnpm agents:check`
finds the mirror out of step with its source:

```
ERR_AGENTS_DRIFT: .claude/skills/ is not a copy of .agents/skills/.
Expected: a byte-identical mirror of .agents/skills/.
Actual:
  differs: .claude/skills/writing-repo-scripts/SKILL.md
Next: run `pnpm agents:sync`.
```

## Coverage

A new script is covered by the `scripts/**` coverage floor from the moment it exists —
an untested file counts as 0%, not as absent from the measurement. **BACKGROUND:**
`placing-tests` explains why `scripts/**` and `scripts/lib/guard/**` carry their own
floors instead of `src/**`'s.

## A script that writes to GitHub

- Create or update only what its manifest declares; never delete what the manifest does
  not name. `scripts/sync-labels.mjs` leaves a label `.github/labels.yml` does not
  mention, and `scripts/apply-ruleset.mjs` never deletes a ruleset no file names, so a
  repository-local addition survives a run.
- A refusal GitHub is known to give gets its own code rather than a raw `gh` exit:
  `ERR_RULESET_PLAN_UNSUPPORTED` when a private repository's plan has no rulesets, apart
  from the `ERR_RULESET_FORBIDDEN` every other refusal reports.
- Its tests never reach GitHub: the `gh` runner is a parameter, and the test hands in an
  in-memory fake, as `tests/sync-labels.test.ts` and `tests/apply-ruleset.test.ts` do.
- Running it against the live repository is a remote write, so it needs the sign-off
  AGENTS.md's "Security and human approval" describes, and its Quick-reference line goes
  in the "Writes to GitHub" block.

## Adding a script

A new file under `scripts/` is finished when every place that names it does, in the same
pull request:

1. Its test, `tests/<script>.test.ts`, with an entry in `vitest.config.ts`'s
   `automationTests` list when it spawns a process or touches the filesystem.
   **REQUIRED:** `placing-tests`.
2. A `package.json` script, when a person or an agent runs it by hand.
3. That script's line in AGENTS.md's Quick reference, in the block that says how it may
   be run: "Checks an agent runs", "Long-running", or "Writes to GitHub".
4. A row in AGENTS.md's "Validating a change" table only when no existing row covers
   what it checks — "A script under `scripts/`" already covers editing it.
5. When a gate runs it — `check:source`, a `ci.yml` step, or `lefthook.yml` —
   **REQUIRED:** `changing-gates`. Joining `check:source` also means a matching `ci.yml`
   step, or `tests/ci-sync.test.ts` fails.
6. A header comment saying what it does, how it is run, and whether it refuses or skips
   outside a git work tree.

**BACKGROUND:** `updating-docs` for the other changes that move two files at once.
