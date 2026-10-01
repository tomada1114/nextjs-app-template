# Adding a second provider adapter

Read `src/ai/adapters/openrouter/` end to end first. It is four small modules — the
request builder, the error mapping, the deadline, and the `generate` that joins them —
and the split is worth copying, because it is what keeps any one of them under the
per-file budget `eslint.config.mjs` sets.

## Before you start

**REQUIRED:** `managing-dependencies` if the vendor ships an SDK you mean to use — it is
a runtime dependency, needs a human's sign-off, and the review record it owes is settled
before the code, not after. Plain `fetch`, as the OpenRouter adapter uses, needs none.
**REQUIRED:** `writing-tests` for the contract suite's own conventions.

The adapter itself is the smaller half of this work. The larger half is the gate and
boundary files that assert against the AI layer's shape, listed under "The gates that
know the vendor" below; each was written for the vendors this repository has shipped, so
each needs the new one added rather than substituted.

## The adapter

1. `src/ai/adapters/<vendor>/` — a new directory. Nothing outside `src/ai/` may import
   from it, and nothing inside it may import another adapter.
2. Implement `LlmPort` from `src/ai/port.ts`, exactly as it is written: `generate`
   resolves to a `Result` for every expected failure, and settles whether or not the
   caller passed a signal. Both promises are asserted by the contract suite, so an
   adapter that breaks one fails rather than degrading quietly.
3. Take construction-time configuration as an options interface — credential, model,
   token ceiling, deadline, and a `fetch` override. The `fetch` override is not optional
   in practice: it is the whole record/replay seam, and without it the adapter cannot be
   tested without a network.
4. Map the vendor's failures onto `LlmErrorCode` in its own module. Copy the axis, not
   the status numbers: the code is chosen by what a caller can _do_, and an unrecognised
   failure falls to `ERR_LLM_UNAVAILABLE`.
5. Compose a total deadline into the request's signal, as
   `src/ai/adapters/openrouter/deadline.ts` does. A vendor SDK that offers a per-attempt
   timeout does not thereby bound the whole call.
6. Publish it from `src/ai/index.ts`. That file is the layer's whole surface; the
   adapter's own modules stay private to it.

## The contract suite

Add one call to `tests/ai-port.test.ts`, beside the existing ones:

```ts
describeLlmPortContract("createMyAdapter", {
  // A fixture whose answer is CONTRACT_ANSWER.
  succeeds: () => replaying("success"),
  // A fixture whose answer does not match CONTRACT_SCHEMA.
  returnsInvalidOutput: () => replaying("invalid-output"),
  // One port per LlmErrorCode, provoked however that vendor produces it — a
  // timeout is a property of the connection rather than of a response, so it
  // has no fixture and is arranged with `neverAnswering()` and a short deadline.
  failsWith: (code) => portFor(code),
  // A fetch that never resolves, under a deadline longer than the suite budget.
  neverAnswers: () => neverAnswering(),
});
```

The harness is the only thing that differs between adapters; the assertions do not, and
that is the point — the same cases run against the fake, the replayed OpenRouter
exchanges, and yours. `failsWith` must be able to produce **every** member of
`LlmErrorCode`; if one of them cannot be provoked from your vendor, that is a finding
about the mapping, not a case to skip.

Adapter-specific behaviour — the status table, a vendor quirk, the request body it
builds — goes in its own suite alongside `tests/ai-openrouter.test.ts`, not into the
shared contract. Its fixtures go in a subdirectory of `tests/fixtures/llm/` named for
the vendor, as `openrouter/` is, so each suite's exact listing sees only its own.

## The gates that know the vendor

- `tests/ai-vendor-swap.test.ts` — its `VENDOR`, `VENDOR_HOST` and `ADAPTER_TREE`
  describe the vendor `src/server/composition.ts` wires, and its factory list fails
  until the new adapter's `create…` is acknowledged there.
- `tests/boundaries.test.ts` — if the vendor ships an SDK, its package name joins the
  `forbidden` list for `src/core/` and gets a case of its own for `src/app/` and
  `src/server/`. A new module needs no entry: the walk is checked by `SCAN_ANCHORS`, a
  named subset, not an exhaustive list. If the composition root starts calling the new
  factory, the access-gate controls there still classify it as billed, which is correct
  unless it truly bills no one.
- `eslint.config.mjs` — an SDK gets a named constant banning it from the `src/core/`,
  `src/app/`, `src/server/` and `src/components/` blocks. Keep the blocks' file sets
  disjoint, as the comment above them requires.
- `tests/ai-layer-removal.test.ts` — `AI_LAYER_TOKENS` gains the new environment
  variable name, and the package name if there is one. Without that, a file naming the
  new vendor is invisible to the removal check. `REMOVED_PATHS` gains the adapter's own
  suite, beside `tests/ai-openrouter.test.ts`: it reads `tests/fixtures/llm` and imports
  `tests/llm-replay.ts`, so a suite left off that list fails this test as a surviving
  file naming a removed one. `REMOVED_SKILL_NAMES` is derived from `REMOVED_PATHS` and
  is not edited by hand.
- `src/server/env.ts` and `.env.example` — a second credential is a second name in the
  schema and a matching line in the example. `tests/server-env.test.ts` asserts the
  correspondence.
- `vitest.config.ts` — a suite that reads fixtures from disk joins `automationTests`, as
  the existing LLM suites do. **REQUIRED:** `placing-tests`.
- `src/server/composition.ts` — the vendor choice. It is a code edit, not a new runtime
  switch: `LLM_ADAPTER` accepts `fake` and nothing else, so the composition root keeps
  answering "which vendor does this application call".

## What not to do

- Do not add a value to `LLM_ADAPTER`. Its one value exists so a test or a keyless run
  cannot bill; a second provider behind it means the composition root no longer answers
  which vendor this application calls.
- Do not widen `LlmRequest` to carry something only your vendor needs. If the port has
  to change, that is a change to what _every_ adapter promises, and it is argued for on
  its own rather than smuggled in with an adapter.
- Do not add a mocking or HTTP-recording dependency. The `fetch` override already
  substitutes the transport, and a library that intercepts at a different layer stops
  testing the code that actually runs.
