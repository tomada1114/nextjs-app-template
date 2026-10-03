# my-package

[![CI](https://github.com/tomada1114/nextjs-app-template/actions/workflows/ci.yml/badge.svg)](https://github.com/tomada1114/nextjs-app-template/actions/workflows/ci.yml)

A short description.

## What this is

A starting point for a Next.js application on the App Router: a locale-prefixed page
tree styled with Tailwind v4 and shadcn/ui, one JSON endpoint, and one language-model
call kept behind an interface rather than called directly. ESM-only TypeScript
throughout.

Two things follow from that last part, and they are most of why this template exists.
Answers come from [OpenRouter](https://openrouter.ai) by default, and switching the
model is one environment variable, `LLM_MODEL`, rather than a code change — while
`LLM_ADAPTER=fake` swaps in a fake adapter that needs no key and bills nothing. And a
project that wants no model at all deletes the layer in one piece instead of unpicking
it, which a test keeps true rather than a convention.

`AGENTS.md` describes the architecture and the rules; this file is the tour.

## Quick start

Use Node.js 24 (the version in `.node-version`) and Corepack. The first run needs no
provider account, credential file, or network call to a model:

```sh
corepack enable
corepack pnpm@11.18.0 install --frozen-lockfile
LLM_ADAPTER=fake pnpm dev
```

Then open <http://localhost:3000>, which redirects to the locale your browser asks for —
`/en` or `/ja`. The page it renders is `src/app/[locale]/page.tsx`, and the text on it
comes from `messages/en.json` and `messages/ja.json`.

Exercise the endpoint while that fake server is running:

```sh
curl --fail-with-body http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Hello","locale":"en"}'
```

Every answer is a fixed sentence and nothing is billed. `fake` is an explicit switch,
never inferred from a missing key: a deployment that lost its key fails rather than
quietly answering from the fake.

To use a real model, copy `.env.example` to `.env`, set `OPENROUTER_API_KEY` and
`API_ACCESS_KEY` there, and run `pnpm dev` without `LLM_ADAPTER=fake`. Never commit the
credential file. Without both keys, `POST /api/ask` refuses to load: every request to it
answers `500` and the server log names the missing variable, while the pages still
render.

There is one API route, `POST /api/ask`, which takes
`{ "prompt": "...", "locale": "en" }` and answers `{ "answer": "..." }`. The `locale` is
a UI locale, and the handler is what maps it to the language the model writes in. The
route answers through the OpenRouter adapter, with `LLM_MODEL` naming any OpenRouter
model id and the adapter's own default used when it is unset;
`src/server/composition.ts` is the single place that decides which adapter is behind it.

Because provider answers are billed, the endpoint is closed. `src/server/composition.ts`
declares that the adapter it wires bills a provider, and `readServerEnv` then requires
`OPENROUTER_API_KEY` and `API_ACCESS_KEY` — a deployment that pays for its answers
refuses to load the route rather than serving anyone who finds the URL — after which it
answers `401` unless the request carries that key as `Authorization: Bearer <value>`.
Under `LLM_ADAPTER=fake` nothing is billed and neither key is required. That is
authentication and nothing more: this template ships no rate limit. Before deploying a
billed adapter, enforce a shared throughput policy at an edge or gateway ahead of the
app. An access key alone does not cap spending.

What the route does bound is the size of a request. The `prompt` is trimmed and must be
1 to 8000 characters, and the body is refused with `413` once it crosses 64 KiB while it
is being read — before the model is asked, on either path. Both ceilings are constants:
`MAX_PROMPT_LENGTH` in `src/server/handlers/ask.ts` and `MAX_REQUEST_BODY_BYTES` in
`src/server/http.ts`. Bodies must be valid UTF-8 JSON; all endpoint responses carry
`Cache-Control: no-store`.

## Extending the app

Add pages under `src/app/[locale]/` and use the locale-aware `Link` from
`src/i18n/navigation.ts`. The home page opts into static rendering; the shared layout
leaves new pages free to read cookies or headers. Put canonical URLs and language
alternates on each page, since inheriting the home's URL would identify a different page
to crawlers.

New model adapters implement `LlmPort` and run the existing contract suite. New
endpoints keep their Web-standard handler under `src/server/handlers/` and wire it in
`composition.ts`; no framework is needed to test a handler. The existing fake adapter
and recorded provider responses keep ordinary checks offline.

## Starting a new app from this template

Copy the tree, then work through
[`starting-an-app`](.agents/skills/starting-an-app/SKILL.md), which owns the procedure
and the order it runs in: rename first, then decide whether to keep the language-model
layer or remove it whole, then decide the locales, then settle the design direction
before the first screen of your own, then run `pnpm check:source` once.

The template ships shadcn/ui's stock neutral tokens so a copied component renders, not a
design anyone chose — `src/app/globals.css` and the
[`designing-ui`](.agents/skills/designing-ui/SKILL.md) skill both say so, and the same
placeholder inventory below reports it until the direction is settled.

The rename is what the title, the description and the author above are waiting for —
they are this template's own identity strings, deliberately left as placeholders.
`tests/placeholders.test.ts` holds the complete list of where one still stands, and a
new app is finished renaming when that list is empty and the test is green.

`pnpm dlx shadcn@latest add <name>` cannot run from this repository's root under its
supply-chain policy; `designing-ui` holds the workaround.

## Development

This package is private: nothing here is packed, published, or consumed as a tarball.

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm check:quick
```

The install puts the Git hooks in place on its own — lefthook's `postinstall` does it,
on every non-CI install — and `package.json`'s `prepare` script then runs
`scripts/verify-hooks.mjs`, which fails the install if the pre-commit hook did not
actually land. So there is no setup step for the hooks; `pnpm hooks:install` is the
repair when that check reports one is needed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow, and
[AGENTS.md](AGENTS.md) for the architecture, the command index, and the rules every
change is held to.

## License

[MIT](LICENSE) © Your Name
