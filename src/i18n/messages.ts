import en from "../../messages/en.json";
import ja from "../../messages/ja.json";
import type { Locale } from "./locales";

/**
 * The catalog shape every locale must provide.
 *
 * @remarks
 * The English catalog is the source of truth for the *shape*: it is the one
 * this repository writes first, and every other locale is a translation of it.
 * {@link MESSAGES} being annotated as a full `Record` is what turns "ja is
 * missing a key" into a type error rather than a blank string at runtime.
 */
export type Messages = typeof en;

/**
 * Every dotted key a translator function accepts, derived from the catalog.
 *
 * @remarks
 * A leaf is a string; anything else is a namespace whose own keys are appended
 * after a dot. `keyof T & string` is what keeps this defined over the JSON
 * object types TypeScript infers, which have no symbol or numeric keys.
 */
type DottedKeys<TCatalog> = {
  [TKey in keyof TCatalog & string]: TCatalog[TKey] extends string
    ? TKey
    : `${TKey}.${DottedKeys<TCatalog[TKey]>}`;
}[keyof TCatalog & string];

/** Every message key in the catalog, as `Namespace.key`. */
export type MessageKey = DottedKeys<Messages>;

/**
 * The catalogs, keyed by locale.
 *
 * @remarks
 * Both are imported statically rather than through a dynamic `import()` per
 * locale. Two small catalogs are not worth a code-split, and a static import is
 * what gives {@link Messages} something to be inferred from.
 */
export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, ja };

/**
 * Every key the catalog is expected to contain, written out.
 *
 * @remarks
 * The two halves of the check pull in opposite directions, which is the point.
 * `satisfies readonly MessageKey[]` fails to compile when an entry here is not
 * in the catalog, and `tests/messages.test.ts` fails when the catalog holds a
 * key this list does not — so neither a rename nor an addition can land with
 * the typed key union and the JSON out of step.
 */
export const MESSAGE_KEYS = [
  "HomePage.title",
  "HomePage.intro",
  "HomePage.localeCount",
  "LocaleSwitcher.label",
  "LocaleSwitcher.en",
  "LocaleSwitcher.ja",
] as const satisfies readonly MessageKey[];

declare module "next-intl" {
  // Teaches `useTranslations`, `getTranslations` and `useLocale` this
  // application's own vocabulary: a key outside the catalog, or a locale
  // outside LOCALES, then fails to compile rather than rendering as its own
  // name at runtime.
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
