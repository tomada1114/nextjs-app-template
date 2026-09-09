import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { LOCALES } from "../src/i18n/locales";
import { MESSAGE_KEYS, type Messages } from "../src/i18n/messages";

// A message catalog is the one place in this repository where a missing entry
// is invisible: `next-intl` renders an absent key as the key itself, in
// production, on a page nobody looked at in that locale. So the catalogs are
// asserted against each other and against the typed key union that `src/`
// compiles with, from the files on disk rather than from what a bundler
// resolved.
//
// AGENTS.md's "everything committed is English" rule stops at `messages/*.json`
// for the obvious reason: a translation catalog whose contents were English
// would not be one.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** One locale's catalog, parsed from `messages/<locale>.json`. */
function readCatalog(locale: string): unknown {
  const file = path.join(repoRoot, "messages", `${locale}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every leaf of `value`, as the dotted key a translator is called with. */
function dottedKeys(value: unknown, prefix = ""): string[] {
  if (!isRecord(value)) {
    return prefix === "" ? [] : [prefix];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    dottedKeys(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

/** The value at a dotted key, or `undefined` when the path does not exist. */
function valueAt(catalog: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, segment) => (isRecord(node) ? node[segment] : undefined),
      catalog,
    );
}

/**
 * The ICU argument names a message reads, in the order they first appear.
 *
 * @remarks
 * Only the name matters here, never the rest of the ICU syntax around it: the
 * plural categories a locale needs are the translator's business — Japanese has
 * `other` where English needs `one` and `other` — but an argument the caller
 * does not pass is a runtime formatting error in that locale alone.
 */
function icuArguments(message: string): string[] {
  const names = [...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].flatMap(
    (match) => match[1] ?? [],
  );
  return [...new Set(names)].sort();
}

/**
 * Whether `message` reads `name` as a `plural` or `selectordinal` argument,
 * which `intl-messageformat` requires a number for; every other argument
 * shape (a plain placeholder, or a `select`'s discriminant) accepts a string.
 */
function isNumericArgument(message: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\{\\s*${escaped}\\s*,\\s*(?:plural|selectordinal)\\b`).test(
    message,
  );
}

/**
 * A dummy value per ICU argument `message` reads, typed to match how the
 * argument is used so a well-formed message never fails to format for a
 * reason unrelated to its syntax.
 */
function dummyIcuValues(message: string): Record<string, string | number> {
  return Object.fromEntries(
    icuArguments(message).map((name) => [
      name,
      isNumericArgument(message, name) ? 1 : "value",
    ]),
  );
}

const catalogs = new Map(LOCALES.map((locale) => [locale, readCatalog(locale)]));

/** The reference catalog: the one every other locale is a translation of. */
const referenceKeys = dottedKeys(catalogs.get("en")).sort();

describe("the message catalogs", () => {
  it("has a catalog for every locale the application ships", () => {
    expect([...catalogs.keys()]).toStrictEqual([...LOCALES]);
  });

  it("found keys to compare, so the assertions below are not vacuous", () => {
    expect(referenceKeys.length).toBeGreaterThan(0);
  });

  it.each([...LOCALES])("gives %s exactly the keys en has", (locale) => {
    expect(dottedKeys(catalogs.get(locale)).sort()).toStrictEqual(referenceKeys);
  });

  it.each([...LOCALES])("leaves no blank message in %s", (locale) => {
    const blank = referenceKeys.filter((key) => {
      const value = valueAt(catalogs.get(locale), key);
      return typeof value !== "string" || value.trim() === "";
    });

    expect(blank).toStrictEqual([]);
  });

  it.each([...LOCALES])("asks %s for the same ICU arguments as en", (locale) => {
    const mismatched = referenceKeys.filter((key) => {
      const reference = valueAt(catalogs.get("en"), key);
      const translated = valueAt(catalogs.get(locale), key);
      if (typeof reference !== "string" || typeof translated !== "string") {
        return true;
      }
      return icuArguments(reference).join() !== icuArguments(translated).join();
    });

    expect(mismatched).toStrictEqual([]);
  });

  // The comparison above only ever looks at argument *names*, extracted with a
  // regular expression that never parses the message. An unbalanced brace, a
  // malformed `plural` clause, or a broken `select` can leave the names
  // untouched and still pass it, then fail at render time in whichever locale
  // nobody was looking at. Actually invoking the message through the same
  // translator the app renders with is what a regular expression cannot
  // stand in for.
  it.each([...LOCALES])(
    "formats every message in %s without an ICU error",
    (locale) => {
      const messages = catalogs.get(locale) as Messages;
      const translate = createTranslator({
        locale,
        messages,
        onError: (error) => {
          throw error;
        },
      }) as unknown as (
        key: string,
        values?: Record<string, string | number>,
      ) => string;

      const broken = referenceKeys.filter((key) => {
        const message = valueAt(messages, key);
        if (typeof message !== "string") {
          return true;
        }
        try {
          translate(key, dummyIcuValues(message));
          return false;
        } catch {
          return true;
        }
      });

      expect(broken).toStrictEqual([]);
    },
  );
});

describe("the typed message keys", () => {
  // `src/i18n/messages.ts` declares MESSAGE_KEYS as `satisfies readonly
  // MessageKey[]`, so a key listed there that the catalog does not hold fails
  // to compile. This is the other direction: a key added to the catalog and
  // never listed.
  it("names every key in the catalog and no others", () => {
    expect([...MESSAGE_KEYS].sort()).toStrictEqual(referenceKeys);
  });
});
