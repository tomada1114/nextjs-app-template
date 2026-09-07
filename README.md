# my-package

[![CI](https://github.com/your-name/my-package/actions/workflows/ci.yml/badge.svg)](https://github.com/your-name/my-package/actions/workflows/ci.yml)

A short description.

## Quick start

```ts
import { normalizeIdentifier } from "my-package";

console.log(normalizeIdentifier("Hello World"));
// => "hello-world"
```

All public symbols are named exports from `src/index.ts`; `src/internal/` is private.

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
