# Adding a second provider adapter

Read `src/ai/adapters/anthropic/` end to end first. It is five small modules — the
client, the request builder, the error mapping, the deadline, and the `generate` that
joins them — and the split is worth copying, because it is what keeps any one of them
under the per-file budget `eslint.config.mjs` sets.

## Before you start

**REQUIRED:** `managing-dependencies` — a vendor SDK is a runtime dependency, and the
review record it owes is settled before the code, not after. **REQUIRED:**
`writing-tests` for the contract suite's own conventions.

The adapter itself is the smaller half of this work. The larger half is the six gate and
boundary files that assert against the AI layer's shape, listed under "The gates that
know the vendor" below; each one names `@anthropic-ai` because there has only ever been
one vendor, and each needs the second one added rather than substituted.

## The adapter

1. `src/ai/adapters/<vendor>/` — a new directory. Nothing outside `src/ai/` may import
   from it, and nothing inside it may import another adapter.
2. Implement `LlmPort` from `src/ai/port.ts`, exactly as it is written: `generate`
   resolves to a `Result` for every expected failure, and settles whether or not the
   caller passed a signal. Both promises are asserted by the contract suite, so an
   adapter that breaks one fails rather than degrading quietly.
3. Take construction-time configuration as an options interface — credential, model,
   token ceiling, per-attempt timeout, retry count, deadline, and a `fetch` override.
   The `fetch` override is not optional in practice: it is the whole record/replay seam,
   and without it the adapter cannot be tested without a network.
4. Map the vendor's failures onto `LlmErrorCode` in its own module. Copy the axis, not
   the status numbers: the code is chosen by what a caller can _do_, and an unrecognised
   failure falls to `ERR_LLM_UNAVAILABLE`.
5. Compose a total deadline into the request's signal, as
   `src/ai/adapters/anthropic/deadline.ts` does. A vendor SDK that offers a per-attempt
   timeout does not thereby bound the whole call.
6. Publish it from `src/ai/index.ts`. That file is the layer's whole surface; the
   adapter's own modules stay private to it.

## The contract suite

Add one call at the bottom of `tests/ai-port.test.ts`:

```ts
describeLlmPortContract("createMyAdapter", {
  // A fixture whose answer is CONTRACT_ANSWER.
  succeeds: () => replaying("success"),
  // A fixture whose answer does not match CONTRACT_SCHEMA.
  returnsInvalidOutput: () => replaying("invalid-output"),
  // One port per LlmErrorCode, provoked however that vendor produces it.
  failsWith: (code) => replaying(FIXTURE_FOR_CODE[code]),
  // A fetch that never resolves, under a timeout longer than the suite budget.
  neverAnswers: () => neverAnswering(),
});
```

The harness is the only thing that differs between adapters; the assertions do not, and
that is the point — the same cases run against the fake, the recorded Anthropic
exchange, and yours. `failsWith` must be able to produce **every** member of
`LlmErrorCode`; if one of them cannot be provoked from your vendor, that is a finding
about the mapping, not a case to skip.

Adapter-specific behaviour — the status table, a vendor quirk, the request body it
builds — goes in its own suite alongside `tests/ai-anthropic.test.ts`, not into the
shared contract.

## The gates that know the vendor

- `eslint.config.mjs` — the SDK ban is a named constant used by two `boundaries/*`
  blocks. Add the new package to it; keep the blocks' file sets disjoint, as the comment
  above them requires.
- `tests/boundaries.test.ts` — three places: the `forbidden` package list for
  `src/core/`, the vendor-SDK case for `src/app/` and `src/server/`, and the exhaustive
  module list in "walks the whole src/ tree", which fails until every new file is added
  to it. That last failure is intended; it is how a new module is noticed at all.
- `tests/ai-layer-removal.test.ts` — `AI_LAYER_TOKENS` gains the new package name, and
  the new environment variable name if there is one. Without that, a file naming the new
  vendor is invisible to the removal check.
- `src/server/env.ts` and `.env.example` — a second credential is a second name in the
  schema and a matching line in the example. `tests/server-env.test.ts` asserts the
  correspondence.
- `vitest.config.ts` — a suite that reads fixtures from disk joins `automationTests`, as
  the two existing LLM suites do. **REQUIRED:** `placing-tests`.
- `src/server/composition.ts` — the one-line vendor choice. It is a line edit, not a
  runtime switch: no environment variable selects between adapters, because that moves
  the choice out of the file whose whole job is to hold it.

## What not to do

- Do not make the adapter selectable at runtime. Two adapters wired behind an
  environment variable means the composition root no longer answers "which vendor does
  this application call".
- Do not widen `LlmRequest` to carry something only your vendor needs. If the port has
  to change, that is a change to what _every_ adapter promises, and it is argued for on
  its own rather than smuggled in with an adapter.
- Do not add a mocking or HTTP-recording dependency. The `fetch` override already
  substitutes the transport, and a library that intercepts at a different layer stops
  testing the code that actually runs.
