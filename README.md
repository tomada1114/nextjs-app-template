# my-package

[![CI](https://github.com/your-name/my-package/actions/workflows/ci.yml/badge.svg)](https://github.com/your-name/my-package/actions/workflows/ci.yml)

A short description.

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

## Development

This repository is private and publishes nothing — no npm package, no generated API
documentation.

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check:quick
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow.

## License

[MIT](LICENSE) © Your Name
