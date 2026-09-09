---
name: integrating-llm
description: >
  Covers the AI layer under src/ai/: what belongs on the vendor-neutral LlmPort versus
  inside an adapter, why @anthropic-ai/sdk is importable only under
  src/ai/adapters/anthropic/, what a structured-output schema does and does not
  guarantee, where a request's deadline sits, and which ERR_LLM_* code a failure
  becomes. Use when editing the port, an adapter, or a file under tests/fixtures/llm/,
  wiring a model call in src/server/composition.ts, recording or replaying an LLM
  fixture, swapping or adding a provider, removing the AI layer, or when a call hangs or
  reaches the network in CI.
---

# Integrating an LLM

**Owns:** the AI layer under `src/ai/` — what the port promises, what an adapter may
know, how a structured answer is constrained and validated, where a request's deadline
is enforced, which `ERR_LLM_*` code a given failure becomes, and how a provider exchange
is recorded and replayed. **Does not own:** the shape of an error class or the `ERR_*`
naming vocabulary (`designing-errors` — this skill owns only what each `ERR_LLM_*` code
_means_ and when an adapter produces it); the Route Handler that calls the port and the
HTTP status it answers with (`building-app-routes`); the mapping from a UI locale to
`outputLanguage` (`localizing-ui`); the removal checklist for the layer as a whole
(`starting-an-app`); how a test case is written (`writing-tests`) and which project it
joins (`placing-tests`).

Model ids and pricing are deliberately not written down here — they go stale faster than
a skill is reread. **BACKGROUND:** the bundled `claude-api` skill, enabled through
`.claude/settings.json`. The SDK in use is the client SDK `@anthropic-ai/sdk`; the
Claude Agent SDK is a different package and this repository does not use it.

## Port or adapter

`src/ai/port.ts` is the whole vendor-neutral vocabulary: a schema, a prompt, a BCP 47
`outputLanguage`, an optional `AbortSignal`, and a `generate` that resolves to a
`Result`. Read its TSDoc first — it states the two promises every implementation makes,
never throwing for an expected failure and always settling, and those are what a new
adapter is measured against.

Everything a provider needs that the port does not name — a model id, a token ceiling, a
per-attempt timeout, a retry count, an HTTP client — is **construction-time
configuration of one adapter**, not a request field. That is the test for where a new
knob goes: on `LlmRequest` it would make the same request un-runnable against the fake,
and the fake is what the contract suite and `pnpm dev` run on.

`@anthropic-ai/*` is importable **only** under `src/ai/adapters/anthropic/`. Enforced
by: `eslint.config.mjs`'s `boundaries/*` blocks, asserted again from the module graph by
`tests/boundaries.test.ts`. Those gates cover `src/core/`, `src/app/` and `src/server/`
and nothing else — not `src/i18n/`, not `src/proxy.ts`, and not inside `src/ai/` itself,
where the rule is yours to hold and matters most: `src/ai/port.ts`, `errors.ts`,
`index.ts` and the fake adapter must stay SDK-free, or the port stops being an interface
a second vendor could implement. `src/ai/index.ts` is the layer's whole surface, and
`src/server/composition.ts` the single line choosing a vendor.

## Two layers of structured output, and only one is guaranteed

**The schema guarantees the _structure_. It never guarantees the _quality_.** Conflating
those is the mistake this section exists to prevent: `z.object({ answer: z.string() })`
is satisfied exactly as completely by `"yes"` as by the paragraph you wanted.
Granularity and usefulness are the prompt's job, plus a post-hoc check written into the
schema — a length floor, an enum, a `refine` — so a shortfall arrives as
`ERR_LLM_INVALID_OUTPUT` rather than as a plausible-looking answer nobody notices.

The structure half is guaranteed twice, against two different things, and both passes
are load-bearing:

1. `buildCreateParams` in `src/ai/adapters/anthropic/request.ts` converts the caller's
   Zod schema with `zodOutputFormat` and sends it as `output_config.format`, so the API
   validates the model's answer against the derived JSON Schema before returning it.
2. `createAnthropicAdapter` in `src/ai/adapters/anthropic/index.ts` then validates the
   same answer against the Zod schema _itself_, with `safeParseAsync`.

The second pass is not belt-and-braces. The conversion to JSON Schema silently drops
what JSON Schema cannot express — a `refine`, a brand — so an answer the API accepted
can still fail the contract the caller wrote; while a construct with no JSON Schema
equivalent at all (`transform`, `pipe`, `z.date`) makes the conversion _throw_ instead,
which is why building the request is its own guarded step. Both TSDoc comments carry the
full argument; read them before changing either half.

`messages.create`, never `messages.parse`. `parse` applies `zodOutputFormat`'s own
parser — Zod's _synchronous_ `safeParse` — which throws outright on a schema carrying an
async refinement, the one thing `LlmPort` promises never to do for an expected failure.
`safeParseAsync` handles both shapes; `src/ai/adapters/fake/index.ts` carries the same
note, and the contract suite asserts it against every adapter.

## A request settles, in three parts

`LlmPort.generate` promises to settle, and a caller's `AbortSignal` is optional — so an
adapter may never assume someone else will time it out. Three bounds compose:

- **The SDK's `timeout`** — `DEFAULT_TIMEOUT_MS` in
  `src/ai/adapters/anthropic/client.ts` — bounds **one attempt, as far as the response
  headers**. The SDK clears it the moment the `Response` resolves, so a provider that
  answers `200` and then dribbles bytes is already past it. `DEFAULT_MAX_RETRIES` is
  pinned in the same file because the SDK's own default multiplies against that timeout.
- **The adapter's own total deadline** — `defaultDeadlineMs(timeoutMs, maxRetries)` in
  that same `client.ts`, applied when the caller omits `deadlineMs`, and armed per
  request by `requestSignal` in `src/ai/adapters/anthropic/deadline.ts` — covers the
  whole call, every attempt and the body read, and covers it with no caller signal at
  all. Derived from the _resolved_ `timeoutMs`/`maxRetries` rather than fixed, so a
  caller who configures either still gets a total bound that fits what they asked for;
  an explicit `deadlineMs` skips the derivation and is honoured verbatim, even when
  shorter than one attempt's `timeoutMs`.
- **The caller's `AbortSignal`** is an _additional and earlier_ deadline layered on top,
  never the only one there is.

The shape to reject is a bespoke `withTimeout`: a `Promise.race` against a timer settles
the promise the adapter returns while leaving the socket open and the body still
arriving, bounding the caller's wait and nothing else. The deadline is instead _composed
into the signal the request is made under_, with `AbortSignal.any`, so firing it
actually cancels the transport — and so an abort between attempts ends the retry chain
rather than starting another one. `deadline.ts`'s TSDoc is the argument in full.

One limit remains, and it is bounded rather than papered over: the SDK's backoff sleep
does not consult the signal, so a deadline firing mid-sleep is noticed only when that
sleep ends. What that can cost is `MAX_RETRY_AFTER_MS` — 8 s — because
`declineLongRetryAfter` in `src/ai/adapters/anthropic/retry-after.ts` ends the retry
chain on a `retry-after` longer than that, so no sleep the SDK starts outlasts the
ceiling on its own computed backoff whatever the provider asked for. The worst case is
therefore `deadlineMs + MAX_RETRY_AFTER_MS`. Under the _derived_ deadline, whose budget
already allows for every sleep, nothing is actually spent; it is a short explicit
`deadlineMs` that overshoots, by the remainder of whatever sleep it landed in. Do not
claim a tighter bound than that in a comment or a document.

That middleware writes `x-should-retry: false` onto a response the provider did not put
it on — the SDK's own control channel, answered by the client to decline a wait it
cannot afford inside a web request. A new adapter that reaches for the same trick owes
the same TSDoc: a reader who takes the header for something the provider sent will
misread every log line downstream of it.

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
out in `src/ai/adapters/anthropic/errors.ts`:

- The axis is **what a caller can do about it** — never which provider produced it, and
  never the status class it arrived in. That is why `400`/`422` become
  `ERR_LLM_INVALID_OUTPUT`: the only request this adapter builds is the caller's own
  schema and prompt, so a rejected one is re-prompted, not retried or reconfigured.
- Anything unrecognised falls to `ERR_LLM_UNAVAILABLE`, whose remedy — try again later —
  is the safe suggestion for a failure nobody has classified yet.
- Every abort is `ERR_LLM_TIMEOUT`, whichever deadline fired, with the reason carried
  through on `cause` by identity. **REQUIRED:** `designing-errors` for why that identity
  matters and how `asError`/`abortedLlmError` keep it.
- A caller's schema that cannot become JSON Schema is `ERR_LLM_INVALID_OUTPUT` too,
  raised before anything is sent — nothing reached the provider, so it must not be
  reported as a transport failure worth retrying.
- An error never carries the prompt, the model's output, or a credential.
  `designing-errors` owns that rule; it binds hardest here, because a provider's own
  error message can quote the request straight back.

Adding a member to the union changes what _every_ adapter promises, so it is declared in
`src/ai/errors.ts` once and then implemented per adapter. Two compile-time backstops
catch a half-done addition: `ALL_CODES` in `tests/ai-port.test.ts` and
`STATUS_BY_LLM_CODE` in `src/server/handlers/ask.ts`.

## Fixtures are recorded once and replayed in CI

The seam is `AnthropicClientOptions.fetch` in `src/ai/adapters/anthropic/client.ts`:
substituting the SDK's HTTP layer means the adapter under test is the same adapter that
talks to the provider — request built, signed and sent, response decoded by the real SDK
— and it needs **no new dependency** to arrange. Reaching for a recording or mocking
library replaces the very thing the test exists to exercise. CI only ever replays;
recording is local, under `LLM_RECORD=1` with a real credential, and costs money.

A fixture must never contain a credential, and that is structural rather than hopeful:
only the status and the response body are written down, so the request — where the SDK
puts `x-api-key` — is never recorded at all. Two layers back it up.
`tests/ai-anthropic.test.ts` scans every committed fixture for `sk-ant-` and for an auth
header; and `scripts/lib/guard/credentials.mjs` matches `sk-ant-` while
`scripts/check-staged.mjs` inspects staged blob content whatever the extension, so
`tests/fixtures/` being excluded from the formatters does not exclude it from the guard.
When a commit is blocked, the answer is to scrub the fixture and record again — never
`--no-verify`, which disables the secret check along with everything else. AGENTS.md's
"Security and human approval" is the rule itself.

Procedure: [references/recording-fixtures.md](references/recording-fixtures.md).

## A second adapter

The contract suite is the deliverable, not the adapter. `describeLlmPortContract` in
`tests/ai-port.test.ts` is exported so it is called once per implementation against a
four-method harness, and an adapter that cannot fill that harness is one whose failures
no caller can handle uniformly. Procedure:
[references/adding-an-adapter.md](references/adding-an-adapter.md).

Streaming responses, and adapters for vendors this repository does not ship, are out of
scope by decision. Do not add speculative support for either.

## Swapping the vendor

Keeping the port and replacing what answers behind it is the **common** path — a project
built from this template usually wants a language model, not necessarily this one — and
it is a bounded edit rather than a rewrite. `tests/ai-vendor-swap.test.ts` is where that
bound is written down and checked, so the list of places the vendor may be named lives
there and is not restated here.

Two lines of application code decide it. `src/server/composition.ts` chooses the adapter
and flips `ADAPTER_BILLS_A_PROVIDER` in the same commit; `src/ai/index.ts` republishes
whichever adapter the layer is willing to expose. `src/server/env.ts` names the
credential, and the rest is manifests and gate configs — the dependency, the import
restriction, the environment example, the automation-test list. The seam test fails the
moment a fourth module joins them, which is the moment the choice of vendor has escaped
the composition root.

Untouched: `src/ai/port.ts`, `src/ai/errors.ts` and the fake adapter — the whole
vendor-neutral vocabulary, and the reason the edit is bounded at all — plus the handler,
which only ever sees an `LlmPort`, and everything above it.

**The provider adapter stays in the tree although the default composition wires the
fake.** A port with only a fake behind it is an untested abstraction: the fake answers
whatever its options say, so it agrees with any interface, including one no real
provider could implement. Running `describeLlmPortContract` against an adapter that
speaks to a real API — over recorded fixtures, so CI neither pays nor reaches the
network — is the only evidence `LlmPort` is genuinely vendor-neutral. Deleting the
adapter to simplify removes the evidence rather than the complexity. The seam test
asserts the contract suite runs against every adapter `src/ai/index.ts` publishes, so a
replacement inherits the same bar the one it replaced met.

## Removing the layer

Three properties let the layer come out in one piece: adapters are private to `src/ai/`,
`src/ai/index.ts` is the only way anything above reaches them, and
`src/server/composition.ts` is the only line _choosing_ a vendor. The same three are
what make the swap above bounded, so an edit that quietly ends one costs both paths at
once.

`tests/ai-layer-removal.test.ts` is the specification, checkable only while the layer is
still present — run it before deleting anything. It names the paths the removal deletes
(this skill among them), the tokens that name the vendor without naming a path, the
names the removed skills are cross-referenced by, and the files that survive but must be
edited. **REQUIRED:** `starting-an-app`, which owns the procedure itself.
