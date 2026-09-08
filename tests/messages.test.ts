import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOCALES } from "../src/i18n/locales";
import { MESSAGE_KEYS } from "../src/i18n/messages";

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
