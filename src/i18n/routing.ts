import { defineRouting } from "next-intl/routing";

import { DEFAULT_LOCALE, LOCALES } from "./locales";

/**
 * How a locale appears in a URL.
 *
 * @remarks
 * The default `localePrefix` — `"always"` — is what makes `/en` and `/ja` the
 * only shapes a page is served under, and `/` a redirect rather than a page.
 * `proxy.ts` performs that redirect and must keep matching the same paths:
 * a request the proxy does not see never acquires a locale prefix, so it falls
 * through to the `[locale]` segment as a literal locale and 404s.
 * `tests/proxy.test.ts` asserts the two agree.
 */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
});
