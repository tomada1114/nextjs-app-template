import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";

import { DEFAULT_LOCALE, LOCALES } from "./locales";
import { MESSAGES } from "./messages";

/**
 * The per-request `next-intl` configuration, as `next.config.ts` wires it.
 *
 * @remarks
 * A default export because that is the shape `createNextIntlPlugin` loads this
 * file by; `eslint.config.mjs` exempts this one path for that reason.
 *
 * The requested locale is validated rather than trusted: the `[locale]` segment
 * is a catch-all, so a request for `/favicon.ico` arrives here as the locale
 * `favicon.ico`. Falling back to {@link DEFAULT_LOCALE} keeps that a rendered
 * page — which the layout then turns into a 404 — instead of a lookup into a
 * catalog that does not exist.
 */
export default getRequestConfig(async (params) => {
  // `requestLocale` is deprecated in favour of `next/root-params`, whose types
  // Next.js generates into `.next/` during a build. Lint and typecheck run
  // before the build here and in CI, so on a fresh checkout that import
  // resolves to the bare `declare module 'next/root-params'` stub and every
  // use of it becomes an `any` — trading one deprecation for a handful of
  // `no-unsafe-*` errors. This directive is scoped to that one rule on that one
  // property, and `reportUnusedDisableDirectives` fails the lint the moment the
  // deprecation goes away.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
  const requested = await params.requestLocale;
  const locale = hasLocale(LOCALES, requested) ? requested : DEFAULT_LOCALE;

  return { locale, messages: MESSAGES[locale] };
});
