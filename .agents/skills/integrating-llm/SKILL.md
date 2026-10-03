---
name: integrating-llm
description: >
  Covers the AI layer under src/ai/: what belongs on the vendor-neutral LlmPort versus
  inside an adapter, why only src/ai/adapters/openrouter/ knows OpenRouter's wire
  format, how LLM_MODEL and LLM_ADAPTER choose the model and adapter, what a
  structured-output schema guarantees, where a deadline sits, and which ERR_LLM_* code a
  failure becomes. Use when editing the port, an adapter, or tests/fixtures/llm/, wiring
  src/server/composition.ts, recording an LLM fixture, swapping or removing a provider,
  or when a call hangs or reaches the network in CI.
---

# Integrating an LLM

**Owns:** the AI layer under `src/ai/` — what the port promises, what an adapter may
know, how a structured answer is constrained and validated, where a request's deadline
is enforced, which `ERR_LLM_*` code a given failure becomes, how the model and the
adapter are chosen at runtime, and how a provider exchange is recorded and replayed.
**Does not own:** the shape of an error class or the `ERR_*` naming vocabulary
(`designing-errors` — this skill owns only what each `ERR_LLM_*` code _means_ and when
an adapter produces it); the Route Handler that calls the port, the HTTP status it
answers with, and the access-key rule in front of it (`building-app-routes`); the
mapping from a UI locale to `outputLanguage` (`localizing-ui`); the removal checklist
for the layer as a whole (`starting-an-app`); how a test case is written
(`writing-tests`) and which project it joins (`placing-tests`).

Model ids and pricing are deliberately not written down here — they go stale faster than
a skill is reread. The one id the code carries is `DEFAULT_MODEL` in
`src/ai/adapters/openrouter/index.ts`, used when `LLM_MODEL` is unset; OpenRouter's own
model list is the authority on what else exists and which models support structured
outputs.

## Port or adapter

`src/ai/port.ts` is the whole vendor-neutral vocabulary: a schema, a prompt, a BCP 47
`outputLanguage`, an optional `AbortSignal`, and a `generate` that resolves to a
`Result`. Read its TSDoc first — it states the two promises every implementation makes,
never throwing for an expected failure and always settling, and those are what a new
adapter is measured against.

Everything a provider needs that the port does not name — a model id, a token ceiling, a
deadline, an HTTP client — is **construction-time configuration of one adapter**, not a
request field. That is the test for where a new knob goes: on `LlmRequest` it would make
the same request un-runnable against the fake, and the fake is what the contract suite,
the smoke test and a keyless local run answer from.

OpenRouter's host and wire format are known **only** under
`src/ai/adapters/openrouter/`. The adapter speaks plain `fetch`, so there is no SDK
import for a lint rule to confine; `tests/ai-vendor-swap.test.ts` asserts instead that
no file under `src/` outside the adapter names the vendor's API host, and
`tests/boundaries.test.ts` that `src/app/` and `src/server/` reach the layer only
through `src/ai/index.ts`. Inside `src/ai/` the rule is yours to hold: `src/ai/port.ts`,
`errors.ts`, `index.ts` and the fake adapter must stay vendor-free, or the port stops
being an interface a second vendor could implement. `src/ai/index.ts` is the layer's
whole surface, and `src/server/composition.ts` the one place choosing a vendor.

## Choosing the model and the adapter at runtime

Two environment variables, both declared in `src/server/env.ts`, and nothing else:

- **`LLM_MODEL`** — any OpenRouter model id, handed to the adapter's `model` option by
  `src/server/composition.ts`. Unset, `DEFAULT_MODEL` answers. It is the only model knob
  by decision: no second tier, no fallback list, no base URL.
- **`LLM_ADAPTER`** — accepts only `fake`. With it, the fake answers, no key is required
  and nothing is billed. It is **never inferred** from a missing `OPENROUTER_API_KEY`: a
  deployment that lost its key must fail, not quietly answer with canned text. Any other
  value fails `readServerEnv`, so a typo cannot fall through to either adapter.

`LLM_ADAPTER` deliberately reverses this layer's older rule that no environment variable
selects an adapter. The smoke test and a keyless local run need a path that cannot bill,
and an explicit value cannot bill by accident; it still has exactly one alternative, so
`src/server/composition.ts` still answers "which vendor does this application call" on
its own. Do not grow it into a general selector.

## Two layers of structured output, and only one is guaranteed

**The schema guarantees the _structure_. It never guarantees the _quality_.** Conflating
those is the mistake this section exists to prevent: `z.object({ answer: z.string() })`
is satisfied exactly as completely by `"yes"` as by the paragraph you wanted.
Granularity and usefulness are the prompt's job, plus a post-hoc check written into the
schema — a length floor, an enum, a `refine` — so a shortfall arrives as
`ERR_LLM_INVALID_OUTPUT` rather than as a plausible-looking answer nobody notices.

The structure half is guaranteed twice, against two different things, and both passes
are load-bearing:

1. `buildRequestBody` in `src/ai/adapters/openrouter/request.ts` converts the caller's
   Zod schema with `z.toJSONSchema` and sends it as a strict `response_format`, with
   `provider.require_parameters` so OpenRouter routes only to a provider that honours
   it, rather than to one that would ignore the schema and answer in prose.
2. `createOpenRouterAdapter` in `src/ai/adapters/openrouter/index.ts` then validates the
   same answer against the Zod schema _itself_, with `safeParseAsync`.

The second pass is not belt-and-braces. The conversion to JSON Schema silently drops
what JSON Schema cannot express — a `refine`, a brand — so an answer the provider
accepted can still fail the contract the caller wrote; while a construct with no JSON
Schema equivalent at all (`transform`, `pipe`, `z.date`) makes the conversion _throw_
instead, which is why building the request is its own guarded step. Both TSDoc comments
carry the full argument; read them before changing either half.

`safeParseAsync`, never the synchronous `safeParse`: the latter throws outright on a
schema carrying an async refinement, the one thing `LlmPort` promises never to do for an
expected failure. `src/ai/adapters/fake/index.ts` carries the same note, and the
contract suite asserts it against every adapter.

## Settling requests and mapping errors

Follow [the deadline and error procedure](references/settling-and-errors.md) for the
adapter's total deadline, caller cancellation, and the remedy each `ERR_LLM_*` code
promises. `src/ai/errors.ts` owns the union; an adapter must implement that contract
without leaking the provider's error text.

## Fixtures are recorded once and replayed in CI

The seam is `OpenRouterAdapterOptions.fetch` in `src/ai/adapters/openrouter/index.ts`:
substituting the adapter's HTTP layer means the adapter under test is the same adapter
that talks to the provider — request built, signed and sent, response decoded — and it
needs **no new dependency** to arrange. Reaching for a recording or mocking library
replaces the very thing the test exists to exercise. CI only ever replays; recording is
local, under `LLM_RECORD=1` with a real credential, and costs money.

A fixture must never contain a credential, and that is structural rather than hopeful:
only the status and the response body are written down, so the request — where the
adapter puts its `authorization` header — is never recorded at all. Two layers back it
up. `tests/ai-openrouter.test.ts` scans every committed fixture for `sk-or-` and for an
auth header; and `scripts/lib/guard/credentials.mjs` matches `sk-or-v1-` while
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

The composition root chooses the adapter and keeps its shared
`src/server/adapter-policy.ts` declaration `ADAPTER_BILLS_A_PROVIDER` true for one that
bills; `src/ai/index.ts` republishes whichever adapter the layer is willing to expose.
`src/server/env.ts` names the credential and requires it, and the rest is the
environment example, the automation-test list and the README's quick start — plus, for a
vendor that ships an SDK, the dependency and an import ban in `eslint.config.mjs`. The
seam test fails the moment a fourth module joins them, which is the moment the choice of
vendor has escaped the composition root.

Untouched: `src/ai/port.ts`, `src/ai/errors.ts` and the fake adapter — the whole
vendor-neutral vocabulary, and the reason the edit is bounded at all — plus the handler,
which only ever sees an `LlmPort`, and everything above it.

**The fake stays in the tree although the default composition wires the provider.** It
is the non-billing path `LLM_ADAPTER=fake` selects, and the baseline the contract suite
is written against. The provider adapter, in turn, is the evidence the port is real: a
fake answers whatever its options say, so it agrees with any interface, including one no
real provider could implement. Running `describeLlmPortContract` against an adapter that
speaks to a real API — over recorded fixtures, so CI neither pays nor reaches the
network — is the only evidence `LlmPort` is genuinely vendor-neutral. The seam test
asserts the contract suite runs against every adapter `src/ai/index.ts` publishes, so a
replacement inherits the same bar the one it replaced met.

## Removing the layer

Three properties let the layer come out in one piece: adapters are private to `src/ai/`,
`src/ai/index.ts` is the only way anything above reaches them, and
`src/server/composition.ts` is the only place _choosing_ a vendor. The same three are
what make the swap above bounded, so an edit that quietly ends one costs both paths at
once.

`tests/ai-layer-removal.test.ts` is the specification, checkable only while the layer is
still present — run it before deleting anything. It names the paths the removal deletes
(this skill among them), the tokens that name the vendor without naming a path, the
names the removed skills are cross-referenced by, and the files that survive but must be
edited. **REQUIRED:** `starting-an-app`, which owns the procedure itself.
