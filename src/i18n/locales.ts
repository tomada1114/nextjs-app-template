/**
 * Every UI language this application ships a message catalog for.
 *
 * @remarks
 * This is the whole of what the rest of the tree needs to know about locales:
 * a closed list and its default. It deliberately imports nothing, so a module
 * that only has to name a locale — a request handler, a test — does not pull
 * `next-intl` and the routing configuration in behind it. `src/i18n/routing.ts`
 * is what turns this list into URL routing.
 *
 * `messages/<locale>.json` must exist for every entry;
 * `tests/messages.test.ts` is what checks that rather than trusting it.
 */
export const LOCALES = ["en", "ja"] as const;

/** One of {@link LOCALES}. */
export type Locale = (typeof LOCALES)[number];

/**
 * The locale served when a request names none, or names one this app does not
 * ship.
 */
export const DEFAULT_LOCALE: Locale = "en";
