---
name: localizing-ui
description: >
  Covers the message catalogs under messages/ and the locale plumbing in src/i18n/:
  adding or renaming a UI string so the catalogs, MESSAGE_KEYS and the typed key union
  stay in step, ICU arguments and plural categories, and linking with Link from
  src/i18n/navigation.ts rather than next/link. Use when adding a translated string,
  editing messages/en.json or messages/ja.json, touching src/i18n/locales.ts,
  messages.ts, routing.ts, request.ts or navigation.ts, adding a locale, mapping a UI
  locale to the LLM port's outputLanguage, or when a message renders as its own key
  name.
---

# Localizing UI

**Owns:** what goes into a message catalog and how a locale reaches the code that
renders it — `messages/*.json`, the typed key union in `src/i18n/messages.ts`, the
locale-aware modules under `src/i18n/`, and the one mapping from a UI locale to the LLM
port's `outputLanguage`. **Does not own:** the shape of a page, layout, Route Handler or
`src/proxy.ts` (`building-app-routes`); how a rendered test case is written
(`writing-tests`) and which vitest project it joins (`placing-tests`); TypeScript idiom
inside a module (`writing-typescript`); dropping a locale when turning this template
into an app (`starting-an-app`).

## A tree full of Japanese is not a violation

AGENTS.md's Conventions makes `messages/*.json` the one exception to the English-only
rule, and states the exception's own limit: it covers the catalogs' string values and
nothing else. Keys stay English, and so does every comment, test, and document about
them. That rule lives in AGENTS.md; this skill only points at it.

The place it is easiest to break is a skill's own frontmatter. Enforced by:
`tests/skills-frontmatter.test.ts`, which rejects CJK in a `description`. A Japanese
example belongs in a fenced block in a body, never in a trigger string.

`typos.toml` scans `messages/` with no exclusion and needs none — Japanese text does not
look like a misspelled English word. If the spell-checker ever fires on a catalog, fix
the text; adding an exclusion is weakening a gate.

## Adding a string, end to end

Four edits, in this order. Doing three of them and running a check reports the half you
have not made yet, so make all four first.

1. `messages/en.json` — add the key under a namespace. English is the source of truth
   for the catalog's _shape_: `Messages = typeof en`.
2. `messages/ja.json` — add the same key. Omitting it is a type error rather than a
   blank string in production, because `MESSAGES` is annotated
   `Readonly<Record<Locale, Messages>>`.
3. `src/i18n/messages.ts` — add the dotted `Namespace.key` to `MESSAGE_KEYS`.
4. Render it: `const t = useTranslations("Namespace")`, then `t("key")`.

Then `pnpm exec vitest run tests/messages.test.ts && pnpm typecheck`.

The two halves of the check pull in opposite directions, and that is the point.
`MESSAGE_KEYS` is `as const satisfies readonly MessageKey[]`, so a key listed there that
no catalog holds fails to compile; `tests/messages.test.ts` fails when a catalog holds a
key the list does not. Neither direction alone catches both, so neither a rename nor an
addition can land with the union and the JSON out of step.

A namespace is a first-level object in the catalog and the argument `useTranslations`
takes. Group by the component that reads it — the template's `LocaleSwitcher` namespace
holds one entry per locale code, which is what lets `switcher(locale)` name a language
without a lookup table of its own.

## ICU arguments and plural categories

- An argument is `{name}`, and every locale's version of a key must ask for the same
  set. Enforced by: `tests/messages.test.ts`, which compares argument names per key
  across catalogs — an argument the caller does not pass is a runtime formatting error
  in that one locale, on a page nobody opened in it.
- Plural **categories** deliberately differ between catalogs, and the test does not
  compare them. `HomePage.localeCount` carries `one` and `other` in `en.json` and only
  `other` in `ja.json`, because Japanese has no singular/plural distinction; an unused
  `one` branch there would be a translation of a grammar the language does not have.

  ```json
  "localeCount": "{count, plural, other {このテンプレートには # 言語が含まれています。}}"
  ```

- `#` inside a plural branch is the count. Pass it as an argument —
  `t("localeCount", { count: LOCALES.length })` — and never format a number into the
  string yourself, which would hard-code one locale's digit grouping into all of them.

## The modules, and which one to reach for

Each file under `src/i18n/` carries its reasoning in its own TSDoc; read the file rather
than a paraphrase. What is worth knowing before you open one:

- `locales.ts` — `LOCALES`, `Locale`, `DEFAULT_LOCALE`. It imports nothing on purpose,
  so a module that only has to name a locale does not pull `next-intl` in behind it.
  Import the list from here, not from `routing.ts`.
- `messages.ts` — the catalogs, `MessageKey`, `MESSAGE_KEYS`, and the
  `declare module "next-intl"` block that teaches `AppConfig` this application's
  `Locale` and `Messages`. That block is why a key outside the catalog fails to compile
  instead of rendering as its own name.
- `routing.ts` — `defineRouting`. `localePrefix` defaults to `"always"`, which is why
  `/en` and `/ja` are the only shapes a page is served under and `/` is a redirect.
- `request.ts` — the per-request config, loaded by exact path from `next.config.ts`, so
  it is a default export and `eslint.config.mjs` exempts it by name. It validates the
  requested locale rather than trusting it: the `[locale]` segment is catch-all, so
  `/favicon.ico` arrives here as the locale `favicon.ico`, and falling back to
  `DEFAULT_LOCALE` keeps that a rendered page the layout can 404 instead of a lookup
  into a catalog that does not exist. Its scoped
  `eslint-disable-next-line @typescript-eslint/no-deprecated` for `requestLocale`
  deletes itself: `reportUnusedDisableDirectives` fails the lint the moment the
  deprecation lifts. Do not widen it to the file.
- `navigation.ts` — `Link`, `getPathname`, `redirect`, `usePathname`, `useRouter`.

**A message that renders as its own key name** means the catalogs and `MESSAGE_KEYS` are
out of step, or the string was read under a namespace that does not hold it. Run
`tests/messages.test.ts` first; it names the key.

## Never `next/link`

Take `Link`, `redirect`, `usePathname` and `useRouter` from `src/i18n/navigation.ts`,
and give them a pathname with no locale in it — `/`, not `/en`. Reaching for `next/link`
or `next/navigation` directly is the mistake that module exists to prevent: it emits a
URL with no locale, `src/proxy.ts` then redirects it, and the reader pays a round trip
and loses the locale they were on.

Passing `locale` to `Link` explicitly is how a language switch targets the other
language, as `src/app/[locale]/page.tsx` does; leaving it off keeps the active one. A
switcher across a tree of pages reads the current path from `usePathname()` in the same
module rather than hard-coding `/`.

**BACKGROUND:** `building-app-routes` for `src/proxy.ts`'s matcher and the `[locale]`
segment, which have to agree with each other.

## The `outputLanguage` seam

`LlmRequest.outputLanguage` in `src/ai/port.ts` is an open BCP 47 tag naming a language
a model can write in. A UI locale is the closed union of the languages this application
ships a catalog for. `OUTPUT_LANGUAGE_BY_LOCALE` in `src/server/handlers/ask.ts` is the
only place the two vocabularies are allowed to meet, and it stays there:

- Never in `src/ai/port.ts` and never in an adapter. The port knows nothing about this
  application's catalogs, which is what keeps it vendor-neutral and the AI layer
  removable in one piece.
- Never in a page or a component. The locale reaches the endpoint as the `locale` field
  of the request body, defaulted to `DEFAULT_LOCALE`.
- The table is `as const satisfies Record<Locale, string>`, so a locale added to
  `LOCALES` without a row fails to compile instead of silently answering in English.
  Pinned by `tests/server-handler.test.ts`.
- The indirection earns its keep on a locale whose tag is not its own name — a `zh`
  catalog answered in `zh-Hans`.

Shared ground with `building-app-routes`: that skill owns the handler's shape and its
error vocabulary, this one owns which tag a locale maps to.

## Adding a locale

The template ships `en` and `ja`. A third is one list read five times: `LOCALES` in
`src/i18n/locales.ts`; a new `messages/<locale>.json` translating every key `en.json`
holds; a static import and a `MESSAGES` entry in `src/i18n/messages.ts`; a row in
`OUTPUT_LANGUAGE_BY_LOCALE`; and a `LocaleSwitcher.<locale>` entry in **every** catalog
— that one is a new key, so `MESSAGE_KEYS` gains a line too. Nothing under `src/app/` or
in `src/proxy.ts` changes; neither names a locale.

Locale negotiation is `next-intl`'s middleware reading the request's `Accept-Language`
header and its locale cookie, and nothing more — no domain routing, no geolocation, no
stored per-user preference. Do not describe one that is not there.

**REQUIRED:** `starting-an-app` for _dropping_ a locale; that is a different list and it
owns it.

## What to run

```bash
pnpm exec vitest run tests/messages.test.ts  # catalogs against each other and MESSAGE_KEYS
pnpm typecheck                               # the satisfies half, and every t() call site
pnpm exec vitest run tests/proxy.test.ts     # only if routing or the matcher changed
pnpm build                                   # only if a page or layout changed
```

Then open `/en` and `/ja` under `pnpm dev`. `pnpm run test:smoke` (after `pnpm build`)
serves the built application and checks that both answer 200 with the matching
`<html lang>`, which catches a locale that never renders at all; nothing checks that a
string reads correctly in it, and that is what opening the pages is for.
