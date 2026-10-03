# Route handlers

## A Route Handler is one re-export line

`src/app/api/ask/route.ts` is a single line re-exporting `askHandler` as `POST`. Copy
that shape for a new endpoint rather than inventing another:

1. Write the logic in `src/server/handlers/<name>.ts` as a
   `create<Name>Handler(dependencies)` factory returning
   `(request: Request) => Promise<Response>`, importing nothing from `next`.
2. Wire it once in `src/server/composition.ts` — the one file that chooses concrete
   dependencies — and export the built handler from there.
3. Re-export it from `src/app/api/<name>/route.ts` under the HTTP verb's name.

Two things make this worth the extra file. The handler is Web-standard, so a test drives
it with a plain `new Request(...)` and no framework, as `tests/server-handler.test.ts`
does. And `src/app/**` carries no coverage floor at all — `vitest.config.ts` thresholds
`src/{core,ai,server}/**` and deliberately leaves the App Router tree out — so logic
parked in a route file is logic no floor measures.

Keep the handler's signature `Request`-only. Next.js passes a dynamic segment's params
as a second argument to the route export, and taking it there is what turns the route
file back into code with untested branches; prefer the request body or the query string,
read from `new URL(request.url)`. If a segment param is genuinely the right shape, the
adaptation line in `route.ts` is the only logic that file may hold, and the parameter
still arrives at the handler as a plain argument.

The response contract is the status, the `error.code` vocabulary, and nothing from a
provider's own error text — a provider message can carry request content back to the
caller. `src/server/handlers/ask.ts` maps codes to statuses through a `satisfies` table
so an added code fails to compile rather than falling through to a default.
**BACKGROUND:** `designing-errors` for the code vocabulary itself.

### Who may call it, and how often

An endpoint under `src/app/api/` has nothing in front of it. `src/proxy.ts`'s matcher
excludes `api` outright, so no middleware runs; whatever the handler does not check, is
not checked. Two consequences, and they are answered differently.

**Authentication is a startup rule, not a per-request decision, and the adapter is what
triggers it.** The composition root's shared declaration in
`src/server/adapter-policy.ts` says whether the default adapter bills a provider
(`ADAPTER_BILLS_A_PROVIDER`). Both `src/instrumentation.ts`'s startup `register` and
`src/server/composition.ts` pass that to `readServerEnv` as `billsAProvider`;
`src/server/env.ts` then refuses an environment with no `API_ACCESS_KEY` — or no
`OPENROUTER_API_KEY` — so a deployment that pays for its answers cannot serve the
endpoint open. The startup hook logs a validation failure and exits non-zero, naming
missing variables. Next.js can retain its listener after preparation failures, so
throwing alone cannot enforce startup health. `next build` evaluates the composition
root while collecting page data, so `readServerEnv` defers the rule while `NEXT_PHASE`
is the production-build phase — a build, and CI, need no credential. Because a runtime
image can inherit that variable too, the rule is not the only guard: with a billed
adapter and no `API_ACCESS_KEY`, `src/server/composition.ts` wires a handler that
answers every request `500 ERR_LLM_AUTH` and never reaches the provider. A billed
endpoint is never served open, whatever the environment says.
`src/server/composition.ts` passes the value down and `src/server/handlers/ask.ts`
compares it, in constant time and with the scheme matched case-insensitively (RFC 9110
§11.1), against the caller's `Authorization: Bearer` credential **before** the body is
read and before the port is reached; a mismatch is `401 ERR_UNAUTHORIZED` with a
`WWW-Authenticate: Bearer` challenge and a fixed sentence.

Key any gate of this kind off what the composition root wires, never off whether a
credential is present in `process.env`. The two are not the same question: a missing key
says nothing about which adapter answers, and a gate that read it that way would turn a
deployment that lost its secret into one answering from somewhere else. A second
provider changes one field of that one declaration and nothing else.

The one setting meant to lift the rule is `LLM_ADAPTER=fake` (`NEXT_PHASE` lifts it only
for the build, as above), because it replaces the billed adapter rather than merely
omitting its key: with it, nothing is required and the endpoint answers anyone, which is
what the smoke test and a keyless `pnpm dev` run on. It is explicit and accepts only
`fake`; it is never inferred from a missing key, and any other value fails
`readServerEnv` rather than falling through to either adapter.

**This template ships no rate limit and no concurrency limit, and that is deliberate.**
A paid-adapter deployment must enforce its caller-throughput policy in an edge or
gateway layer before `POST /api/ask` reaches the app. That enforcement point must be
shared across instances; its exact store, algorithm, caller key, quota, window, and
concurrency policy belong to the deployment rather than this template. `src/proxy.ts` is
not the limiter because its matcher excludes `api` paths, so it does not run there. A
consuming application may add a handler-local limiter for defense in depth, but that is
not the deployment-wide safeguard and is not part of this issue.

**What the endpoint does bound is the size of one request.** `src/server/http.ts` reads
a JSON body through a wrapper that abandons it once it crosses `MAX_REQUEST_BODY_BYTES`,
rather than trusting `Content-Length` — a header that is absent under chunked transfer
encoding and is otherwise whatever the client says it is, so only what is actually read
bounds anything. The request schema bounds the `prompt` at both ends after trimming it,
which is what bounds the input tokens billed for a call. Read a new endpoint's body
through the same helper instead of calling `request.json()`, and keep both refusals
ahead of the port: a request rejected after the model has answered has already been paid
for.

The endpoint all of this is illustrated with is the AI layer's only caller, so removing
that layer deletes `src/app/api/` and `src/server/composition.ts` outright. The pattern
above outlives them — the first endpoint of your own restores the composition root — but
until one exists, this section names files that are gone. **BACKGROUND:**
`starting-an-app`, which owns the removal and lists this skill among the files it edits.
