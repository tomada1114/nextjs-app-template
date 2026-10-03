# Gate files

## CI workflows

`tests/workflows.test.ts`'s `lintWorkflow` is the mechanical half, and it is cheaper to
read before writing a workflow than after the run goes red. It rejects, each with its
own `ERR_WORKFLOW_*` code:

- `pull_request_target` anywhere — it runs fork code with a writable token.
- an action not pinned to a 40-character commit SHA, or pinned with no trailing
  `# vX.Y.Z` comment saying which release that SHA is. A local `./…` action is exempt,
  having no SHA to pin.
- a missing top-level `permissions`, or one wider than `{}` or `contents: read`.
- a job that declares no `permissions` of its own, or grants `write-all`.
- a workflow that declares no jobs at all, and a job whose steps the scanner cannot
  reach — every step rule reads the same step list, so a job it cannot read is a hole in
  all of them at once and is reported rather than passed. A job that calls a reusable
  workflow through its own `uses:` is exempt, having no steps to find.
- a job with no `timeout-minutes`. A step-level timeout does not substitute.
- an `actions/checkout` step without `persist-credentials: false`.
- `actions/setup-node` ordered before `pnpm/action-setup`, whose failure mode is a
  silently empty store cache rather than an error.
- a `pull_request` workflow with no `concurrency`; and, on any workflow that runs on
  `push` at all — push-only included — an unconditional `cancel-in-progress`: killing a
  push run destroys the only CI record a merged commit gets, and a push-only workflow
  has no pull-request run to fall back on. Both rules read every declaration GitHub
  Actions accepts, the workflow's own and each job's, in the block spelling and in the
  flow mapping alike. The flow mapping has to be one physical line with balanced braces.
  Only two shapes are read at all — a flow collection whose braces balance on its own
  line, and a plain scalar taken at face value — and anything else is refused as
  `ERR_WORKFLOW_CONCURRENCY_UNREADABLE`, the same way an unreadable `on:` or trigger
  entry is refused as `ERR_WORKFLOW_ON_UNREADABLE`. The `on:` check reads the header,
  every outermost sequence entry or mapping key, and every flow entry; it does not read
  event bodies such as `branches:` or `types:`. That covers a flow collection continued
  onto the next line or unbalanced because a quoted value carries a brace, one left
  unbalanced by a collection that opens part-way along the value rather than at its
  first character, and a value led by a YAML anchor, alias or tag (`&`, `*`, `!`) — none
  of which is the scalar the rules behind the check would otherwise take it for.
  Refusing the class rather than widening the detector is deliberate: an alias carries
  no brace at all, so a detector hunting for one would still pass it, and teaching the
  group and cancel readers to look past an indicator is the same flow-scalar parser this
  bullet ends by ruling out. Being readable is a property of the whole declaration, not
  of its first line: the `group:` and `cancel-in-progress:` values are read wherever
  they are written — in the header's inline value, in a one-line flow mapping's entry,
  or on their own body line — and each is refused on the line it sits on, under that
  same code. Only those two keys are checked, since they are the only values the two
  rules read. An unreadable header is the exception that reports once: the lines under a
  value already refused are fragments of it rather than values of a declaration this
  lint has read. That refusal does not silence the cancel rule: the cancel-on-push loop
  still reads an unreadable block's body, so a spelling it happens to catch — an
  unconditional `cancel-in-progress: true` sitting on its own line — is reported
  alongside it as `ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH`, both codes on the same block
  rather than one hiding the other. Nor does it silence the missing-concurrency rule
  wholesale: that one is suppressed only by a `group:` question this lint could not
  read, so a block naming no group and carrying an unreadable `cancel-in-progress` is
  reported under both codes. Rejoining physical lines into one flow value is a
  flow-scalar parser this repository has decided not to write. A workflow-level block
  covers every job and a job-level one covers only its own, so declaring it per job
  answers the first rule only when every job does, and only when the block names a
  `group:` — a bare `concurrency:` key queues nothing. Any block cancelling
  unconditionally trips the second, except on a job whose own `if:` pins it to a pull
  request: that job never runs on push, so no push record is what its cancellation
  discards.
- a multi-line `run:` that neither opens with `set -euo pipefail` nor runs under a
  fail-closed `defaults.run.shell`. `shell: bash` is not enough: it leaves `-u` off.
- a `pnpm … install` without `--frozen-lockfile`, which would make every other gate
  advisory.

Reading each of those blocks is `blockOf`, and indentation is not all it goes on: YAML
lets a block sequence start in the same column as the key it belongs to, so a key
awaiting a block value claims same-column `- ` entries as well as more deeply indented
ones. That is what keeps `steps:` written at its own column from reading as a job with
no steps, and it is why a fix for one such blind spot belongs in `blockOf` rather than
in the caller that noticed it.

Those rules hold for **every** workflow this repository ever gains, a deploy workflow
included: the suite runs `lintWorkflow` over whatever `.github/workflows/` contains. Two
lists in that file are exact and only a human edits them.

- The filename list in "includes every workflow spec 02 §5.2 makes mandatory" is
  compared with `toEqual`, so a new workflow file fails the suite until it is added
  there. That failure is the review prompt, not an obstacle to route around.
- The writers list in "grants a write scope only where the job cannot do its work
  without one" is `["codeql.yml", "pr-label.yml"]` today. A workflow carrying any
  `: write` scope has to join it — a deploy workflow that pushes, tags, or comments
  included.

The judgment half no test encodes:

- A new workflow file is warranted only when the work does not belong as a job inside
  `ci.yml` — a different trigger shape or a genuinely separate permission footprint, not
  a convenience split.
- Widening write access, or adding a second workflow that writes, is a security-relevant
  change and needs the weight of review a new write grant deserves, not a routine CI
  edit.
- A PR that deletes or narrows a security-relevant step (the pin, the `permissions`
  block, `persist-credentials: false`, a timeout) must say in its own body why the
  removed protection no longer applies here. Silence is not review for that.

Renaming a job that is a required context, gating one with `if:` or `paths:`, or adding
a job that should block merges also edits `.github/rulesets/main.json` in the same pull
request (`tests/ruleset-contexts.test.ts` catches a stale context locally), and the live
ruleset only follows once the owner re-runs `pnpm repo:ruleset`:
[required-checks.md](required-checks.md).

## `lefthook.yml`

The hook is deliberately narrow, and AGENTS.md's "Enforcement layers" holds the argument
for why. The bar for a new or changed job follows from it: it must never fire on
intended work — test it against a normal commit before trusting it to catch a bad one.

A changed job only reaches an author whose clone has the hook, and what puts it there is
lefthook's own `postinstall`, allowlisted in `pnpm-workspace.yaml`, on every non-CI
`pnpm install`. Nothing here re-installs it: `package.json`'s `prepare` script runs
`scripts/verify-hooks.mjs`, which **verifies and never writes**, because the defect
issue #81 was really about is that lefthook's postinstall cannot fail — it ignores the
exit status of the `lefthook install -f` it spawns, so a hook that could not be written
leaves the install green and silent.

The verifier checks both halves, and neither is redundant. `lefthook.yml` has to declare
a `pre-commit` block, because `lefthook install` run without a config _creates a blank
one_, reports success and exits 0 — an empty gate that installs cleanly. And a lefthook
pre-commit hook has to exist at the path `git rev-parse --git-path hooks` resolves to,
which is asked rather than assumed: `core.hooksPath` set to a writable directory is
perfectly fine and is not a defect, and a linked worktree's hooks live in the shared
common directory. Verification skips only where it is meaningless (`CI` set, not a Git
work tree root, no `lefthook` in `node_modules`) and otherwise fails the install with an
`ERR_HOOKS_*` report naming `ALLOW_MISSING_GIT_HOOKS=1`, the one deliberate opt-out.
`tests/verify-hooks.test.ts` pins that behaviour against throwaway `git init`
repositories and the real lefthook, the `prepare` entry included; it isolates `HOME` and
`XDG_CONFIG_HOME` rather than relying on `isolatedGitEnv`, which strips `GIT_*` and so
cannot keep a developer's global `core.hooksPath` out of a fixture repository.

Pointing `prepare` at an installer instead is the change to reject: it repeats what
lefthook already does, and repeats it just as silently, which leaves AGENTS.md's "every
author, any tool" row resting on an install nobody checked.

Job ordering is load-bearing rather than incidental. `format` runs alone before the
parallel group so `eslint`, `typecheck` and `check:staged` see the formatted, re-staged
blobs rather than the working tree as it stood before the commit began. Preserve that
shape across an edit instead of parallelizing it away. A job that inspects file
_content_ — `check:staged` today — must stay in the group that runs after `format`.

Two jobs carry no `glob` on purpose: `check:staged` has to see every staged path
whatever its extension, and `test:related` has to see the paths themselves to work out
what is related, including a staged test file with no production counterpart. Adding a
glob to either narrows it in a way nothing reports. When a new extension enters the tree
(`.tsx` did), the globbed jobs are the ones to revisit.

## What `check:staged` actually covers

`scripts/check-staged.mjs` inspects the git index: for each staged change it classifies
the **path** through `scripts/lib/guard/paths.mjs`'s `checkCommit` (the `.env*`,
`secrets/**`, and `.claude/settings.local.json` shapes, **minus direnv's bare
`.envrc`**) and, when the path passes, the staged **blob content** through
`scripts/lib/guard/credentials.mjs`'s `checkCredentials`. `checkCommit` shares one body
with the agent-read rule `checkRead` and differs from it on that single basename: a
direnv project tracks its `.envrc` on purpose, so this layer judges it on content, while
`checkRead` still refuses to open it. That is the whole of its scope. It judges nothing
about whether a commit weakens a gate — that is the pull request's job.

Two properties are worth knowing before relying on it or editing it:

- It rejects a file on its **basename alone** when the name looks like a private key —
  `KEY_FILE_SUFFIXES` and `KEY_FILE_BASENAMES` in `check-staged.mjs`, matched
  case-insensitively — because such a file may be binary or encrypted and so cannot be
  relied on to trip the content patterns. That rule lives in `check-staged.mjs` itself,
  **not** under `scripts/lib/guard/**`, so it sits under the broader `scripts/**`
  coverage floor rather than the stricter guard floor. A change to it needs its test
  written deliberately; the aggregate floor will not ask for one.
- `checkStagedChange` returns `null` for `change.status === "D"`. **A staged deletion is
  never inspected** — deleting a secret-shaped file, a workflow, or a test passes this
  layer untouched, by design. Nothing else in the repository watches for it either.
- The generic hardcoded-password rule judges the **value**, not the key. A key ending in
  `password`, with an optional surrounding quote and a `:` or `=` separator, only makes
  a site a candidate; `isCredentialShapedValue` then decides. A value qualifies when it
  is at least eight characters, is an unbroken run of printable ASCII, opens no
  interpolation, and mixes at least three of four character classes — lower case, upper
  case, digits, punctuation — with `.` and `_` counted as neither, since they are what
  an identifier is made of. Three classes is what separates a generator's output from
  the strings people deliberately write next to a password key: a kebab-case identifier
  (the `new-password` autocomplete value a sign-in form carries), a README placeholder,
  a masked display value and a URL each mix two and pass.
- The expression markers — a dollar sign, a backtick, brackets, braces, angle brackets —
  reject a **bare** value outright, because there they mean the right-hand side is code.
  They do not reject a quoted one: inside quotes a generated password carries them as
  content, so a quoted body is rejected only on a real interpolation opener (`${`, `$(`,
  a backtick). A bare value is captured to the next whitespace and then stripped of a
  trailing `,` or `;`, so a value holding one is judged whole rather than truncated
  below the length floor.
- One shape the class test cannot reach is bought back by context instead: an upper
  snake case key ending in the env-style password name, assigned a bare alphanumeric
  word of eight characters or more that runs to the end of its line, is blocked. That is
  the compose-file, CI-service and env-file service credential, where a single
  lower-case word is the whole secret and no shape test could tell it from a
  placeholder; the context does the work an eight-character word cannot. A `,` or `;`
  continuing a JavaScript object or type takes the site back out. It is the one place
  the key's shape decides anything, and the cost comes with it: a bare eight-character
  placeholder under such a key is blocked too, and the way past that is an empty value,
  the convention `.env.example` already follows.
- What the rule therefore does **not** cover: a secret under eight characters; one
  mixing only two character classes, which includes a lower-case word with digits stuck
  on the end unless it sits under an upper snake case key; one holding a space or a
  non-ASCII character; one assembled by interpolation; a body whose quote is escaped;
  and the whitespace-separated schema form, which is a type declaration rather than an
  assignment and is excluded on purpose. A real password that also reads as an
  identifier or as a placeholder therefore walks through. That is the deliberate half of
  the trade: ordinary code — a schema field, a type member, a destructured read — and
  the placeholder strings documentation is written with are no longer blocked, and a
  hook that fires on intended work teaches its author to reach for `--no-verify`, which
  switches off every rule in `credentials.mjs` at once.

## Tool configs

Each of `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc.json` and
`next.config.ts` holds its own current values — read the file rather than a copy of a
rule written elsewhere. A PR changing one owes three things in its body: which rule or
option moved, why, and what now passes or newly fails that did not before. AGENTS.md
governs whether the change is allowed at all; this skill does not restate that.

Traps that have cost time here:

- In `eslint.config.mjs`, `no-restricted-syntax` and `no-restricted-imports` **replace**
  their options across config objects rather than merging. A narrower block that sets
  either rule silently switches off every entry it does not restate — which is why
  `NO_ENUM` and `NO_EXPORT_STAR` are shared constants and why the `boundaries/*` blocks
  match disjoint file sets. Keep a new block disjoint from them, or restate what it
  still wants.
- Anchor a zone pattern with a leading `../`. Unanchored, `**/server` also matches the
  package subpath `next-intl/server`, which `src/i18n/request.ts` imports today;
  `../**/server` cannot match any bare specifier. Same shape for `../**/app` against
  `next/app`. `no-restricted-imports` matches this specifier text through the `ignore`
  package rather than resolving it, and `ignore` treats a leading `./` as a different
  string from a leading `../` — so `./../server` is invisible to `../**/server` even
  though it resolves to the same module. Every `ZONE` entry and `AI_LAYER_PRIVATE`
  therefore carries a `./../**` twin of each `../**` pattern; a bare specifier still
  cannot start with `./..`, so the twin is exactly as safe as the pattern it doubles.
- The `@/*` alias `tsconfig.json` declares is a third spelling of the same module, and
  it needs no anchor: no bare package name can start with `@/`, since an empty scope is
  not legal. It still needs its own entry — a zone left without an `@/` twin is a
  boundary the alias walks straight through — which is why `zonePatterns()` generates
  all six forms per zone and `AI_LAYER_PRIVATE` carries an `!@/ai/index` exemption of
  its own. A resolver added later (a bundler, a test runner) reads neither `paths` nor
  this config, and has to be told about the alias separately, the way
  `vitest.config.ts`'s `resolve.alias` is.
- A `group` accepts `!` negations, and the **last matching entry wins**. That is how
  `AI_LAYER_PRIVATE` states the AI layer's surface as an allow-list —
  `["../**/ai/**", "./../**/ai/**", "!../**/ai/index", "!./../**/ai/index"]` — rather
  than a deny-list naming each private module, which would go stale the next time
  something lands under `src/ai/`. Both patterns must come before both negations, since
  the `./../` twin needs its own exemption too.
- `eslintConfigPrettier` must stay the last element of the exported array. Anywhere else
  it stops turning off the stylistic rules that would fight Prettier, and the two gates
  then disagree about the same file.
- `eslint-config-next` states its rule blocks against `**/*`; this config re-scopes each
  to the `src/` tree on the way in. Spreading a new shared config in unscoped puts
  framework rules on `scripts/**` and `tests/**`.
- The named blocks are the map: `src/shared-syntax`, `src/size-budget`,
  `public-api/explicit-surface`,
  `boundaries/core-is-framework-free-and-imports-no-zone`,
  `boundaries/ai-imports-only-core`, `boundaries/port-does-not-know-its-adapters`,
  `boundaries/i18n-is-a-leaf`, `boundaries/app-reaches-the-ai-layer-through-src-ai`,
  `boundaries/server-reaches-ai-through-src-ai-and-never-app`,
  `boundaries/components-import-only-core-and-i18n`,
  `boundaries/private-trees-are-not-importable`, `automation/node-scripts`,
  `tests/vitest-rules`, `tests/relaxations`. Seven of the `boundaries/*` blocks are one
  import order written per zone, so they match disjoint file sets by construction; the
  eighth protects private trees from `tests/` and `scripts/`. Name a new block the same
  way — the name is what a reader, and ESLint's own config inspector, has to identify it
  by.
- `tests/boundaries.test.ts` asserts those same edges from the module graph, and it pins
  zones rather than files. An exhaustive list of the modules under `src/` failed on
  every legal new file, which teaches its reader to edit the meta-test until the day
  that edit hides something real; a table of zones fails only on a change that needs a
  boundary decision — a new zone, or a second module at the root of `src/`.
- `vitest.config.ts` runs four projects — `unit`, `component` (jsdom), `automation`,
  `smoke` — and coverage is collected once for the whole run, never per project. `smoke`
  is the one the default run filters out (`--project='!smoke'` in `test`,
  `test:coverage`, `test:watch` and `test:related`), because it serves `pnpm build`'s
  output and there is none in ci.yml's `test` job. Which project a file joins, and the
  value of any threshold, are `placing-tests`. What belongs here is that `extends: true`
  is what carries the shared `allowOnly`/restore/unstub settings into a project: a
  hand-written project object without it drops them silently.
- `next.config.ts` is a gate as well as a build config: `agentRules: false` is what
  stops `next dev` appending to AGENTS.md behind the author. Removing it makes a
  hand-written source of truth a tool rewrites.
