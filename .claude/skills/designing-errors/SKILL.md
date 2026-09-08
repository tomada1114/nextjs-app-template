---
name: designing-errors
description: >
  Covers the shape of an error type and the vocabulary of its `code` string, in both
  src/** — LlmError and the ERR_LLM_* codes src/ai/errors.ts declares — and scripts/**,
  where a stage prefix such as ERR_AGENTS_* or ERR_LABELS_* is reported on stderr. Use
  when adding or changing an Error subclass, choosing or renaming an ERR_* code,
  deciding what an error may carry and what it must never carry (a credential, a prompt,
  a model's output), wiring an AbortSignal rejection reason, or writing the PR line that
  a changed code needs.
---

# Designing Errors

**Owns:** the shape of an error type and the vocabulary of `code` strings, in both
`src/**` and `scripts/**`. **Does not own:** which `ERR_LLM_*` code an adapter produces
for a given provider failure (`integrating-llm`, when it lands); general type-system
judgment (`writing-typescript`); how an error is asserted in a test (`writing-tests`);
the HTTP status and response body a code is answered with (`building-app-routes`); the
full stderr message shape for repository automation (`writing-repo-scripts` — the `ERR_`
prefix rule below is shared with it).

## The one rule that matters

**`code` is the contract; `message` is not.** A caller branches on `code` because it is
a stable string literal; `message` is prose for a human reading a log and may be
reworded at any time. Never write a test, a catch clause, or a script's own error
handling that matches on `message` text — match on `code`, or on the error's class via
`instanceof`.

## Shape of an error class

- Subclass `Error`, set `this.name` to the class name in the constructor, and declare
  `readonly code` as a **literal** type — never `string`. The literal is what lets a
  consumer narrow on `code` and get a typed error back.
- Two spellings, both correct, chosen by how many failures the class covers. One class
  over a closed vocabulary takes the code as a constructor parameter typed as the union
  (`LlmError`, in `src/ai/errors.ts`); a class per failure declares
  `readonly code = "ERR_..." as const`. A class whose `code` widens to `string` gives a
  consumer nothing to switch on and is the shape to reject in review.
- Keep the underlying failure on `cause` rather than folding it into `message`.
  `LlmError` carries the provider's own error there, so a log can still show it without
  any caller having to know that provider's error classes.

```ts
export class SchemaMismatchError extends Error {
  /** Literal, not `string`: this is what a caller narrows on. */
  readonly code = "ERR_SCHEMA_MISMATCH" as const;

  /** The path that failed — never the value that was at it. */
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`The value at ${path} did not match the expected schema.`, options);
    this.name = "SchemaMismatchError";
    this.path = path;
  }
}
```

## What an error may never carry

An error travels further than the code that raised it: into a log, an aggregator, a
crash report, and — through a response body — back to whoever made the request. Decide
what it holds on that basis, not on what would be convenient to debug with.

- **Never a credential.** No API key, no `Authorization` header, no URL with a token in
  its query string, no environment value read through `src/server/env.ts`.
- **Never request content.** The prompt, the model's output, and the parsed request body
  are all data someone else supplied; a message that quotes them turns every log line
  into a copy of them. Name the shape instead — a field path, a length that was
  exceeded, an allowed set — not the content.
- The worked example is `src/server/handlers/ask.ts`: it answers with the failure's
  `code`, an HTTP status and one fixed sentence, and sends **none** of the provider's
  own error text, because a provider message can carry the prompt back to the caller.
  The provider error is on `cause`, which is for the server-side log and stops there.
- For an argument-validation error, the field that names what was rejected is the dotted
  path as written in the public signature (`options.maxLength`) — never an internal
  variable name, which can be renamed without that being a contract change.

## Aborts keep the caller's reason by identity

When a function reports an abort, the reason the caller passed must survive as the same
object, not as a fresh error carrying the same message — a caller that aborts with its
own instance compares `error.cause === myReason` to learn that _its_ cancellation is
what happened, and a copy breaks that.

- `asError(reason, fallback)` in `src/ai/errors.ts` is the helper: it returns the reason
  itself when it already is an `Error`, and otherwise wraps it, keeping the raw value (a
  string, `undefined`, anything `abort()` may carry) on `cause`.
- `abortedLlmError(reason)` builds the error an aborted request reports, with that
  preserved reason on `cause`. `tests/ai-port.test.ts` pins both halves — identity for
  an `Error` reason, wrapping for a non-`Error` one.
- The mirror image, for a function that _raises_ the abort: pass the exact same error
  instance to `controller.abort(...)` and to the rejection, so a cooperating operation
  reading `signal.reason` sees the identical object the caller's `catch` receives.

## Choosing a `code` string

- `ERR_` prefix, `SCREAMING_SNAKE_CASE`, describing the failure rather than the function
  that raised it (`ERR_LLM_TIMEOUT`, not `ERR_GENERATE_FAILED`).
- Under `src/**`, the prefix after `ERR_` names the layer the code belongs to, and the
  layer owns its union in one file: `src/ai/errors.ts` declares every failure an
  `LlmPort` may report. Read it for what each member means — its TSDoc groups them by
  what a caller can _do_ about each, which is the axis the vocabulary is built on, not
  which provider produced it. Add a member there, once, rather than per adapter: a new
  member changes what every adapter promises.
- Under `scripts/**`, the code carries the stage prefix of the check that raised it
  (`ERR_AGENTS_*` in `scripts/sync-agents.mjs`, `ERR_LABELS_*` in
  `scripts/lib/labels-manifest.mjs`, `ERR_GIT_*`, `ERR_GH_*`), so the code alone —
  without opening the script — tells you which check to go read. Pick an existing stage
  prefix over inventing a new one when the failure belongs to a check that already has
  one.
- When a function can fail for several structurally different reasons, model them as a
  discriminated union keyed on `code` (or one class per reason) rather than one class
  with several optional fields — a consumer should be able to `switch` on `code` and get
  every field narrowed, not check which optional fields happen to be set.

## Changing a `code`

Nothing here is published, so this is not a semver decision. It is still a contract
change: AGENTS.md counts the `ERR_LLM_*` codes and the `error.code` vocabulary of the
HTTP surface among the things a caller outside the process observes, so adding,
renaming, or removing one changes what a client's `switch` compiles against and what an
operator's alerting matches on.

- Say so in the PR body, in one line naming the old code, the new one, and what a client
  has to change. A code that changes silently is one nobody downstream finds out about
  until an alert stops firing.
- There is a compile-time backstop for one half of it: `STATUS_BY_LLM_CODE` in
  `src/server/handlers/ask.ts` is written
  `as const satisfies Record<LlmErrorCode, number>`, so a code added to or removed from
  the union fails the build until that table agrees. It cannot see a client, and it
  cannot see a `scripts/**` code at all.
