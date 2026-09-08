# my-package

[![CI](https://github.com/your-name/my-package/actions/workflows/ci.yml/badge.svg)](https://github.com/your-name/my-package/actions/workflows/ci.yml)

A short description.

## Quick start

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:3000>. The page it renders is `src/app/page.tsx`.

There is one API route, `POST /api/ask`, which takes `{ "prompt": "..." }` and answers
`{ "answer": "..." }`. It runs against a fake language-model adapter, so it needs no
credentials; `src/server/composition.ts` is the single place that decides which adapter
is behind it. Copy `.env.example` to `.env` when you swap in one that needs a key.

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
