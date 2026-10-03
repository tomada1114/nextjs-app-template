# Locale checklist

## The locale decision

The template ships `en` and `ja`. Keeping both costs nothing and is the default; the
other choice is dropping one, and a third locale is added by reading the same list
forward. Dropping `ja` touches:

- `src/i18n/locales.ts` — `LOCALES`, which is the closed union everything else derives
  from.
- `messages/ja.json`, deleted, and `src/i18n/messages.ts`, which statically imports it
  and keys `MESSAGES` by locale.
- `messages/en.json` — the switcher entry naming the dropped language.
- `src/server/handlers/ask.ts` — `OUTPUT_LANGUAGE_BY_LOCALE`, the one place a UI locale
  is mapped to the language the model writes in. Only if the AI layer stayed.
- `tests/messages.test.ts` — its switcher key in `MESSAGE_KEYS`, plus every other place
  it names the locale literally — and `tests/proxy.test.ts`, `tests/home-page.test.tsx`,
  and `tests/server-handler.test.ts`, each of which names the locale literally too.
- `README.md`'s quick start, and AGENTS.md's Conventions exception, which names
  `messages/ja.json` as the one committed file that is not in English.

`src/proxy.ts` does **not** change: its matcher excludes API routes, framework asset
trees and paths with an extension, and names no locale at all. `tests/proxy.test.ts`
does change, because its cases spell one out.

Two of these fail at compile time rather than at runtime, by design:
`OUTPUT_LANGUAGE_BY_LOCALE` and `MESSAGE_KEYS` are written with `satisfies`, so a locale
removed from `LOCALES` without its entries removed fails `pnpm typecheck` instead of
rendering a key as its own name in production — `MESSAGE_KEYS` lives in
`tests/messages.test.ts` rather than in `src/`, but `tsconfig.json`'s `include` covers
`tests`, so `pnpm typecheck` type-checks it there too. Check with:

```bash
pnpm exec vitest run tests/messages.test.ts tests/proxy.test.ts
```

One locale still means a prefixed URL: `localePrefix` defaults to `"always"` in
`src/i18n/routing.ts`, so `/` keeps redirecting to `/en`. Changing that is a routing
decision, not part of the rename, and it is what `tests/proxy.test.ts` asserts either
way.
