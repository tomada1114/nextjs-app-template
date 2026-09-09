---
name: building-app-routes
description: >
  Covers working inside the Next.js App Router tree: adding a page or a layout under
  src/app/, deciding which file carries a "use client" directive, keeping
  src/app/api/<name>/route.ts a one-line re-export of a Web-standard handler wired in
  src/server/composition.ts, what belongs in src/proxy.ts, and reading configuration
  through src/server/env.ts. Use when adding or changing a route, page, layout or Route
  Handler, editing the proxy matcher, adding an environment variable or a NEXT_PUBLIC_
  name, or when an unprefixed path 404s while every check stays green.
---

# Building App Routes

**Owns:** what goes where when a request is served — the Server/Client boundary inside
`src/app/`, the shape of a Route Handler and the handler behind it, `src/proxy.ts`, and
how configuration reaches any of them. **Does not own:** the `LlmPort` contract and the
adapter behind it (`integrating-llm`); message catalogs and the locale routing they
configure (`localizing-ui`); how a test case is written (`writing-tests`) and which
vitest project it joins (`placing-tests`); TypeScript idiom inside a module
(`writing-typescript`).

The zones, the direction imports run in, and what each zone publishes are AGENTS.md's
Architecture section; their literal patterns and budgets are `eslint.config.mjs`'s
`boundaries/*`, `public-api/explicit-surface` and `src/size-budget` blocks, asserted
again from the module graph by `tests/boundaries.test.ts`. Read those for the rules.
This skill is the procedure for working inside them.

## The two paths a request takes

A page request passes `src/proxy.ts` (locale detection), then `src/app/layout.tsx`,
`src/app/[locale]/layout.tsx`, and the page. A JSON request goes to
`src/app/api/<name>/route.ts`, which re-exports a handler that
`src/server/composition.ts` built. Deciding where new code goes is mostly deciding which
of those files is the smallest one that can hold it — and, for anything with logic, the
answer is almost never a file under `src/app/`.

## The Server / Client boundary

Every file under `src/app/` is a Server Component until one says `"use client"`. This
template ships no such file: `src/app/[locale]/page.tsx` calls `useLocale` and
`useTranslations` and still runs on the server, because `next-intl` publishes a
`react-server` export condition and those hooks resolve to a server implementation
there. A hook is therefore not evidence that a file is a Client Component — the
directive is, and nothing else is.

- Add `"use client"` to the smallest file that actually needs the client: the one owning
  state, an effect, a browser API, or a DOM event handler. Pass it data as props from
  the server file above it.
- Never put the directive on a layout to make a child work. It marks the whole subtree,
  moves it into the client bundle, and the next reader has no way to see which
  descendant needed it.
- Nothing under `src/server/` belongs in a client file. `src/server/env.ts` and
  `src/server/composition.ts` import `server-only`, so those two fail the build instead
  of inlining a secret into a bundle — but only `pnpm build` sees it, and a handler
  module carries no such marker, so there the rule holds by discipline.

An **asynchronous** Server Component is not unit-tested here. `LocaleLayout` in
`src/app/[locale]/layout.tsx` awaits its `params`; Testing Library renders on the client
renderer, which has nothing to resolve that promise with, so a test of it would assert
against a render production never performs. `vitest.config.ts`'s `component` project
covers the synchronous case instead — `tests/home-page.test.tsx` renders `HomePage`
under jsdom and supplies the `NextIntlClientProvider` context a real Server Component
tree would have provided. Everything asynchronous is checked by `pnpm build` and by
opening the page.

### Adding a page

The segment goes under `src/app/[locale]/`, not beside it: every page path carries a
locale prefix, so a route added outside that segment is one the proxy prefixes and the
tree then fails to match. Link to it with `Link` from `src/i18n/navigation.ts` and an
unprefixed pathname — `next/link` produces a URL with no locale, which costs a proxy
redirect round trip and drops the locale the reader was on. Then run `pnpm build` and
open the page. **BACKGROUND:** `localizing-ui` for the catalog the page reads its
strings from.

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
triggers it.** `src/server/composition.ts` declares whether the adapter it wires bills a
provider (`ADAPTER_BILLS_A_PROVIDER`) and passes that to `readServerEnv` as
`requiresAccessKey`; `src/server/env.ts` then refuses an environment with no
`API_ACCESS_KEY`, so a deployment that pays for its answers cannot boot with the
endpoint open — `readServerEnv` throws and the server stops as it starts.
`src/server/composition.ts` passes the value down and `src/server/handlers/ask.ts`
compares it, in constant time and with the scheme matched case-insensitively (RFC 9110
§11.1), against the caller's `Authorization: Bearer` credential **before** the body is
read and before the port is reached; a mismatch is `401 ERR_UNAUTHORIZED` with a
`WWW-Authenticate: Bearer` challenge and a fixed sentence.

Key any gate of this kind off what the composition root wires, never off whether a
credential is present in `process.env`. The two are not the same question: a machine
exports `ANTHROPIC_API_KEY` for all sorts of reasons — recording the LLM fixtures under
`LLM_RECORD=1` is one — while this application still answers from the fake adapter and
bills no one, and a presence-based gate would refuse to start, build, or load a test
suite there for nothing. A second provider changes one field of that one declaration and
nothing else.

The zero-credential quick start is untouched by all of this: with the fake adapter
wired, nothing is required and the endpoint answers anyone, which is the promise
`pnpm dev` makes.

**This template ships no rate limit and no concurrency limit, and that is deliberate.**
Doing it properly needs a store shared across every instance — a Redis, a database row,
a platform primitive — and which one is a deployment decision this template cannot make
for you. So an access key holder can still spend without bound, and a key that leaks is
a bill. When you add one, it goes in the same place the access-key check does: at the
top of the handler in `src/server/handlers/ask.ts`, ahead of `llm.generate`, with the
store injected through `AskHandlerDependencies` like every other dependency — never read
from `process.env` in the handler, and never in `src/proxy.ts`, which does not run for
`api` paths at all.

The endpoint all of this is illustrated with is the AI layer's only caller, so removing
that layer deletes `src/app/api/` and `src/server/composition.ts` outright. The pattern
above outlives them — the first endpoint of your own restores the composition root — but
until one exists, this section names files that are gone. **BACKGROUND:**
`starting-an-app`, which owns the removal and lists this skill among the files it edits.

## `src/proxy.ts`

Next.js 16 renamed `middleware.ts` to `proxy.ts`. In this repository that file is
`src/proxy.ts`, **not** the repository root, because the App Router tree lives under
`src/` and Next.js looks for the proxy beside it.

This is the trap this section exists for: at the repository root the file is simply
never loaded, and `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm test` all stay
green while every unprefixed path 404s. The one check that sees it is
`pnpm run test:smoke`, which serves the build with `next start` and asks it for `/` —
and it runs after `pnpm build`, not from `pnpm test`, so a green `pnpm check:quick`
still proves nothing here. A `/` that 404s under `pnpm dev` while the gate is green is
this, until proven otherwise.

- What belongs in it: a cheap decision made on the way to a route, for every matching
  request. Locale detection is the one it ships.
- What does not: data fetching, a database or model call, anything reading a secret, and
  anything slow. It runs ahead of every matching request and its cost is paid on all of
  them.
- `config.matcher` and the `src/app/[locale]/` segment have to agree — a path the proxy
  skips never acquires a locale prefix and then 404s against the segment. Both halves
  are asserted by `tests/proxy.test.ts`; run it whenever you touch either.
- The file is loaded by exact path through its default export, which is why
  `eslint.config.mjs` names it beside `src/app/**` and `src/i18n/request.ts` as an
  exemption to the default-export ban. That exemption list is for framework-owned entry
  points; a module of your own does not join it.

## Configuration

`src/server/env.ts` is the only module under `src/` that reads `process.env`. Everything
else — a page, a component, a handler, the proxy — receives what it needs as an
argument, wired in `src/server/composition.ts`. That is what makes "where does this
secret enter the process" a question answered by opening one file.

- Adding a variable means adding it to the schema in `src/server/env.ts` _and_ to
  `.env.example` with an empty value. `tests/server-env.test.ts` asserts that the two
  agree; it is the check to run first.
- A blank value reads as absent on purpose, so copying `.env.example` to `.env` is not a
  configuration error. Decide deliberately whether a new name is optional or required —
  a required one stops the process at startup, since `readServerEnv` throws rather than
  returning a `Result`: a malformed environment is a deployment mistake no caller can
  recover from.
- Never open a real `.env` to find out what exists. `src/server/env.ts` is the list of
  names and `.env.example` ships every one of them; AGENTS.md holds the prohibition.

### `NEXT_PUBLIC_`

Next.js inlines any variable whose name starts with `NEXT_PUBLIC_` into the client
bundle at build time. It is not a scope, an access rule, or a convenience for reaching a
value from a component — it is publication. Consequences worth deciding on before typing
the prefix:

- Never prefix a credential, a token, or anything whose disclosure matters. There is no
  later step that redacts it.
- The value is frozen into the build. Changing it needs a rebuild and a redeploy, and
  every deploy that shipped the old value still carries it.
- Anything genuinely public can equally be a constant in `src/core/` or a prop passed
  down from a Server Component — both of which a reviewer can see in the diff, which a
  variable read out of the environment at build time is not.

This repository declares no `NEXT_PUBLIC_` name today. Adding the first one is a
decision to state in the PR, not a detail.

## What each check actually covers

AGENTS.md's "Validating a change" table names the narrowest check per file; the part
worth knowing while working here is what those checks cannot see.

- `pnpm test` never renders the App Router tree and never starts a server. It covers the
  handler, the proxy's exported matcher and function, and synchronous components.
- `pnpm typecheck` does not resolve `"use client"`, the `server-only` marker, or the
  export shape a page or route file must have.
- `pnpm build` is the only check that does, so run it after touching anything under
  `src/app/` — and open the page, which is still the only way to learn that a request
  reached it at all.
