# my-package

[![CI](https://github.com/tomada1114/nextjs-app-template/actions/workflows/ci.yml/badge.svg)](https://github.com/tomada1114/nextjs-app-template/actions/workflows/ci.yml)

A short description.

## What this is

A starting point for a Next.js application on the App Router: a locale-prefixed page
tree, one JSON endpoint, and one language-model call kept behind an interface rather
than called directly. ESM-only TypeScript throughout.

Two things follow from that last part, and they are most of why this template exists. A
fake adapter is wired in by default, so `pnpm dev` answers a request before any
credential exists — the first thing you do with a checkout is run it, not go and find an
API key. And a project that wants no model at all deletes the layer in one piece instead
of unpicking it, which a test keeps true rather than a convention.

`AGENTS.md` describes the architecture and the rules; this file is the tour.

## Quick start

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:3000>, which redirects to the locale your browser asks for —
`/en` or `/ja`. The page it renders is `src/app/[locale]/page.tsx`, and the text on it
comes from `messages/en.json` and `messages/ja.json`.

There is one API route, `POST /api/ask`, which takes
`{ "prompt": "...", "locale": "en" }` and answers `{ "answer": "..." }`. The `locale` is
a UI locale, and the handler is what maps it to the language the model writes in. The
route runs against a fake language-model adapter, so it needs no credentials;
`src/server/composition.ts` is the single place that decides which adapter is behind it.
Copy `.env.example` to `.env` when you swap in one that needs a key.

## Starting a new app from this template

Copy the tree, then work through
[`starting-an-app`](.agents/skills/starting-an-app/SKILL.md), which owns the procedure
and the order it runs in: rename first, then decide whether to keep the language-model
layer or remove it whole, then decide the locales, then run `pnpm check:source` once.

The rename is what the title, the description and the author above are waiting for —
they are this template's own identity strings, deliberately left as placeholders.
`tests/placeholders.test.ts` holds the complete list of where one still stands, and a
new app is finished renaming when that list is empty and the test is green.

## Development

This repository is private and publishes nothing — no npm package, no generated API
documentation.

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check:quick
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow, and
[AGENTS.md](AGENTS.md) for the architecture, the command index, and the rules every
change is held to.

## License

[MIT](LICENSE) © Your Name
