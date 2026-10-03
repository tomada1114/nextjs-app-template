# Settling requests and mapping errors

## A request settles

`LlmPort.generate` promises to settle, and a caller's `AbortSignal` is optional — so an
adapter may never assume someone else will time it out. Two bounds compose:

- **The adapter's own total deadline** — `DEFAULT_DEADLINE_MS` in
  `src/ai/adapters/openrouter/deadline.ts`, or the `deadlineMs` it was constructed with
  — covers the whole call: the request, the response headers, and the body behind them.
  The adapter makes exactly one attempt, so there is no per-attempt timeout or retry
  budget to derive it from; it is the only bound there is, and it holds with no caller
  signal at all.
- **The caller's `AbortSignal`** is an _additional and earlier_ deadline layered on top,
  never the only one there is.

The shape to reject is a bespoke `withTimeout`: a `Promise.race` against a timer settles
the promise the adapter returns while leaving the socket open and the body still
arriving, bounding the caller's wait and nothing else. The deadline is instead _composed
into the signal the request is made under_, with `AbortSignal.any` in `requestSignal`,
so firing it actually cancels the transport. `deadline.ts`'s TSDoc is the argument in
full.

An out-of-range `deadlineMs` throws a `RangeError` at construction — the one place this
layer throws rather than answering with a `Result`. It catches two different platform
failures at once, and the second is the one a new adapter author will not reproduce on
their own. A delay outside `AbortSignal.timeout`'s unsigned 32-bit range throws there
instead, and the signal is armed outside every `try`, so leaving it unchecked would turn
a composition-root mistake into the rejected promise `LlmPort` says never happens. A
delay merely above Node's _signed_ 32-bit timer ceiling throws nothing at all: Node
clamps it and the deadline fires within a millisecond rather than after the duration
asked for, so the failure arrives as an answer at completely the wrong time and no error
anywhere. `MAX_DEADLINE_MS` is that signed ceiling — `INT32_MAX`, not the unsigned bound
— for exactly that reason.

## Which `ERR_LLM_*` code, and when

`src/ai/errors.ts` owns the union and its TSDoc groups the members by remedy; it is not
restated here. What this skill owns is the mapping a new adapter must reproduce, worked
out in `src/ai/adapters/openrouter/errors.ts`:

- The axis is **what a caller can do about it** — never which provider produced it, and
  never the status class it arrived in. Only OpenRouter's documented invalid-model JSON
  error (`error.code: 400`, `error.message: "Invalid model specified"`) becomes
  `ERR_LLM_CONFIG` (https://openrouter.ai/docs/api_reference/streaming, checked
  2026-10-03). Other `400` bodies retain `ERR_LLM_INVALID_OUTPUT`: the status alone does
  not distinguish model configuration from per-request parameter rejection. The handler
  returns `500` and logs a fixed hint naming `LLM_MODEL`, without the provider's text or
  an environment value. `422` and the moderation refusal `403` remain
  `ERR_LLM_INVALID_OUTPUT`; `401` and `402` (no credits) are fixed in the account —
  `ERR_LLM_AUTH`. The documented example is replayed by
  `tests/fixtures/llm/openrouter/invalid-model-400.json`, with its source and explicit
  hand-written provenance; it is not a live recording.
- Anything unrecognised falls to `ERR_LLM_UNAVAILABLE`, whose remedy — try again later —
  is the safe suggestion for a failure nobody has classified yet. A `200` that carries
  an `error` object instead of a completion is mapped by the same table.
- Every abort is `ERR_LLM_TIMEOUT`, whichever deadline fired, with the reason carried
  through on `cause` by identity. **REQUIRED:** `designing-errors` for why that identity
  matters and how `asError`/`abortedLlmError` keep it.
- A caller's schema that cannot become JSON Schema is `ERR_LLM_INVALID_OUTPUT` too,
  raised before anything is sent — nothing reached the provider, so it must not be
  reported as a transport failure worth retrying.
- An error never carries the prompt, the model's output, or a credential.
  `designing-errors` owns that rule; it binds hardest here, because a provider's own
  error message can quote the request straight back — which is why `providerError` keeps
  that text on `cause` and puts only the status in `message`.

Adding a member to the union changes what _every_ adapter promises, so it is declared in
`src/ai/errors.ts` once and then implemented per adapter. Two compile-time backstops
catch a half-done addition: `ALL_CODES` in `tests/ai-port.test.ts` and
`STATUS_BY_LLM_CODE` in `src/server/handlers/ask.ts`.
