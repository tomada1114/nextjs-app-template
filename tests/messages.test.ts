import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, expectTypeOf, it } from "vitest";

import { LOCALES } from "../src/i18n/locales";
import { MESSAGES, type MessageKey, type Messages } from "../src/i18n/messages";

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

/** The ICU argument shapes that change what dummy value a message needs to format without error; everything else accepts a plain string. */
type IcuArgumentType =
  "plain" | "number" | "plural" | "selectordinal" | "select" | "date" | "time";

interface IcuArgument {
  name: string;
  type: IcuArgumentType;
  /**
   * A `select` argument's own branch keys, so a dummy value can pick one that
   * actually exists on the message rather than relying on an implicit
   * `other` fallback the message may not declare.
   */
  selectOptions: readonly string[];
}

const KNOWN_ARGUMENT_TYPES: ReadonlySet<string> = new Set([
  "number",
  "plural",
  "selectordinal",
  "select",
  "date",
  "time",
]);

function toIcuArgumentType(type: string): IcuArgumentType {
  return KNOWN_ARGUMENT_TYPES.has(type) ? (type as IcuArgumentType) : "plain";
}

/**
 * A hand-written recursive-descent scan of ICU MessageFormat syntax: it walks
 * brace nesting explicitly instead of scraping argument names with a single
 * regular expression. A regular expression cannot tell a top-level `{name}`
 * from a `select`/`plural` branch's own label or one-word message body — both
 * are a bare word immediately inside braces — and widening its character
 * class to accept every name ICU allows (a hyphen included) would only make
 * that ambiguity worse. Recursing on brace boundaries makes both
 * distinctions structural instead: a branch's selector key is consumed as a
 * key, never examined for a name, and only what is nested *inside* a
 * branch's own `{...}` is scanned again for an argument reference.
 *
 * `@formatjs/icu-messageformat-parser` is what `next-intl` actually compiles
 * with (via `use-intl` and `intl-messageformat`), which would make this
 * unnecessary — but it is not a direct dependency of this repository, and
 * pnpm's non-hoisted `node_modules` does not expose a transitive package that
 * is not declared: `require.resolve("@formatjs/icu-messageformat-parser")`
 * fails with `MODULE_NOT_FOUND` from this tree. Adding it as a direct
 * dependency is out of scope for a test file, so this scan stands in for it.
 *
 * This is not a validator: malformed ICU syntax (an unbalanced brace, a
 * broken `plural` clause) is left for `createTranslator` itself to reject at
 * format time, in the test below. This function only has to extract what it
 * can without throwing or looping forever, for a catalog that may not yet be
 * valid.
 */
function parseIcuArguments(message: string): IcuArgument[] {
  const found: IcuArgument[] = [];
  const seen = new Set<string>();
  const { length } = message;
  let pos = 0;

  // Letters, digits, and underscore — not a hyphen. `intl-messageformat`'s
  // own identifier rule accepts any character that is not Unicode
  // whitespace or `Pattern_Syntax`, and a hyphen *is* `Pattern_Syntax`:
  // confirmed empirically that `{user-name}` raises
  // `MALFORMED_ARGUMENT` from the real parser, so a hyphenated name is
  // not legal ICU and is already caught as broken by the invoke-through-
  // `createTranslator` test below regardless of what this scan does with
  // it. Digits are included because a leading digit (`{1fast}`) *is*
  // legal and the original `[A-Za-z_]\w*` missed it the same way it
  // missed a hyphen — that gap is real even though the hyphen example
  // was not.
  function isNameChar(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z0-9_]/.test(char);
  }

  function skipSpace(): void {
    while (pos < length && /\s/.test(message[pos] ?? "")) pos++;
  }

  function readWhile(matches: (char: string) => boolean): string {
    const start = pos;
    while (pos < length && matches(message[pos] ?? "")) pos++;
    return message.slice(start, pos);
  }

  function record(
    name: string,
    type: IcuArgumentType,
    selectOptions: readonly string[] = [],
  ): void {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    found.push({ name, type, selectOptions });
  }

  /**
   * Consumes a `plural`/`selectordinal`/`select` argument's `key {pattern}`
   * branches, up to (not including) the argument's own closing brace.
   * Returns the branch keys seen, which only a `select` argument's dummy
   * value needs.
   */
  function parseBranches(): string[] {
    const keys: string[] = [];
    skipSpace();
    while (pos < length && message[pos] !== "}") {
      const key = readWhile((char) => char !== "{" && char !== "}" && !/\s/.test(char));
      if (key !== "") keys.push(key);
      skipSpace();
      if (message[pos] === "{") parsePattern();
      skipSpace();
    }
    return keys;
  }

  /**
   * Consumes one branch's `{pattern}`, recursing into a nested argument
   * reference but never mistaking the branch's own literal text — even a
   * single word that happens to look like a name — for one.
   */
  function parsePattern(): void {
    pos++; // consume '{'
    while (pos < length && message[pos] !== "}") {
      if (message[pos] === "{") parseArgument();
      else pos++;
    }
    if (message[pos] === "}") pos++;
  }

  /** Consumes `number`/`date`/`time`'s optional style or `{skeleton}`, up to (not including) the argument's own closing brace. */
  function skipStyle(): void {
    while (pos < length && message[pos] !== "}") {
      if (message[pos] === "{") parseArgument();
      else pos++;
    }
  }

  /** Consumes one `{...}` argument reference; `message[pos]` is its opening brace. */
  function parseArgument(): void {
    pos++; // consume '{'
    skipSpace();
    const name = readWhile(isNameChar);
    skipSpace();

    if (message[pos] === "}") {
      pos++;
      record(name, "plain");
      return;
    }
    if (message[pos] !== ",") {
      return; // unbalanced or malformed; createTranslator reports this, not this scan
    }
    pos++; // consume ','
    skipSpace();
    const type = toIcuArgumentType(readWhile((char) => /[A-Za-z]/.test(char)));
    skipSpace();
    if (message[pos] === ",") pos++;

    if (type === "plural" || type === "selectordinal" || type === "select") {
      record(name, type, parseBranches());
    } else {
      record(name, type);
      skipStyle();
    }
    skipSpace();
    if (message[pos] === "}") pos++;
  }

  while (pos < length) {
    if (message[pos] === "{") parseArgument();
    else pos++;
  }

  return found;
}

/**
 * The ICU argument names a message reads, in the order `parseIcuArguments`
 * first records them.
 *
 * @remarks
 * Only the name matters here, never the rest of the ICU syntax around it: the
 * plural categories a locale needs are the translator's business — Japanese has
 * `other` where English needs `one` and `other` — but an argument the caller
 * does not pass is a runtime formatting error in that locale alone.
 */
function icuArguments(message: string): string[] {
  return [
    ...new Set(parseIcuArguments(message).map((argument) => argument.name)),
  ].sort();
}

/**
 * A dummy value per ICU argument `message` reads, typed from the argument's
 * own ICU type so a well-formed message never fails to format for a reason
 * unrelated to its syntax: a `Date` for `date`/`time`, a number for
 * `number`/`plural`/`selectordinal`, one of the message's own branch keys for
 * `select`, and a plain string for a bare placeholder.
 */
function dummyIcuValues(message: string): Record<string, string | number | Date> {
  return Object.fromEntries(
    parseIcuArguments(message).map(
      ({ name, type, selectOptions }): [string, string | number | Date] => {
        if (type === "number" || type === "plural" || type === "selectordinal") {
          return [name, 1];
        }
        if (type === "date" || type === "time") {
          return [name, new Date("2024-01-01T00:00:00Z")];
        }
        if (type === "select") {
          return [
            name,
            selectOptions.includes("other") ? "other" : (selectOptions[0] ?? "value"),
          ];
        }
        return [name, "value"];
      },
    ),
  );
}

const catalogs = new Map(LOCALES.map((locale) => [locale, readCatalog(locale)]));

/** The reference catalog: the one every other locale is a translation of. */
const referenceKeys = dottedKeys(catalogs.get("en")).sort();

/**
 * Every key the catalogs are expected to hold, written out by hand.
 *
 * @remarks
 * This is the one thing here that is *not* derived from `messages/en.json`.
 * `MessageKey` is (`DottedKeys<typeof en>`), so it agrees with the catalog by
 * construction and can never report a key that was never added; only a list a
 * human maintains as the fourth edit of `localizing-ui`'s "adding a string" can.
 * `as const satisfies` rather than an annotation of `readonly MessageKey[]`,
 * which would discard the literal tuple type and let a new key land with no
 * entry here — the same reasoning `type-testing` names for a literal list
 * that has to stay in step with a union.
 */
const MESSAGE_KEYS = [
  "HomePage.title",
  "HomePage.intro",
  "HomePage.localeCount",
  "LocaleSwitcher.label",
  "LocaleSwitcher.en",
  "LocaleSwitcher.ja",
] as const satisfies readonly MessageKey[];

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

  // MESSAGES is annotated Readonly<Record<Locale, Messages>>, and every
  // catalog is assignable to Messages — so `{ en, ja: en }` type-checks and
  // ships a copy-paste that serves English under /ja. This is also what keeps
  // MESSAGES a value import: `vitest related` only sees this suite depend on
  // messages/en.json through the value chain messages.test.ts ->
  // src/i18n/messages.ts -> messages/en.json, since every other case here
  // reads the catalogs with readFileSync, which Vite's module graph cannot
  // see. A type-only import would silently stop lefthook's test:related job
  // from selecting this suite when a translator edits a catalog.
  it.each([...LOCALES])("serves %s the catalog on disk", (locale) => {
    expect(MESSAGES[locale]).toStrictEqual(catalogs.get(locale));
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

  // The comparison above only ever looks at argument *names*, and never asks
  // next-intl to actually compile the message. An unbalanced brace, a
  // malformed `plural` clause, or a broken `select` can leave the names
  // untouched and still pass it, then fail at render time in whichever locale
  // nobody was looking at. Actually invoking the message through the same
  // translator the app renders with, with a rethrowing `onError`, is what
  // catches that; `dummyIcuValues` passing a values object also defeats
  // next-intl's no-compile fast path, so every message is genuinely parsed
  // rather than only the ones a component happens to pass arguments to.
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
        values?: Record<string, string | number | Date>,
      ) => string;

      // Each failure keeps the ICU error's own message, not just the key
      // name: the whole point of actually parsing the message is the
      // diagnostic, and a maintainer reading a failed assertion needs the
      // reason, not just which key broke.
      const broken = referenceKeys.flatMap((key) => {
        const message = valueAt(messages, key);
        if (typeof message !== "string") {
          return [`${key}: not a string`];
        }
        try {
          translate(key, dummyIcuValues(message));
          return [];
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return [`${key}: ${reason}`];
        }
      });

      expect(broken).toStrictEqual([]);
    },
  );

  describe("dummy ICU values", () => {
    // Finding: a date/time argument used to get the string "value", the same
    // as a bare placeholder, and formatting a valid `{when, date, short}`
    // message then threw `FORMATTING_ERROR: Invalid time value` — a false
    // positive on a perfectly valid message. No catalog uses `date`/`time`
    // today, so this fixture is what stands in for one.
    it("passes a Date for a date/time argument, so a valid date message formats", () => {
      const message = "{when, date, short}";
      const translate = createTranslator({
        locale: "en",
        messages: { Fixture: { when: message } },
        onError: (error) => {
          throw error;
        },
      }) as unknown as (
        key: string,
        values?: Record<string, string | number | Date>,
      ) => string;

      expect(() => translate("Fixture.when", dummyIcuValues(message))).not.toThrow();
    });

    // Finding, as reported: the argument-name scan used `[A-Za-z_]\w*`,
    // which skips a "legal ICU argument name such as `{user-name}`".
    // Checked empirically against the real parser (the same one
    // `createTranslator` compiles with) and rejected: a hyphen is Unicode
    // `Pattern_Syntax`, which `intl-messageformat`'s own identifier rule
    // excludes, so `{user-name}` is not valid ICU syntax at all — it
    // raises `MALFORMED_ARGUMENT` regardless of what dummy value this
    // scan supplies, and the invoke-through-`createTranslator` test above
    // already reports it as broken for that reason.
    it("still reports a hyphenated name as broken, because it is not legal ICU syntax", () => {
      const message = "{user-name}";
      const translate = createTranslator({
        locale: "en",
        messages: { Fixture: { greeting: message } },
        onError: (error) => {
          throw error;
        },
      }) as unknown as (
        key: string,
        values?: Record<string, string | number | Date>,
      ) => string;

      expect(() => translate("Fixture.greeting", dummyIcuValues(message))).toThrow(
        /MALFORMED_ARGUMENT/,
      );
    });

    // The real latent gap `[A-Za-z_]\w*` had: a name is legal ICU syntax as
    // long as it starts with a character that is not Unicode whitespace or
    // `Pattern_Syntax`, so a *digit*-leading name such as `{1fast}` is
    // legal and the old pattern (start class `[A-Za-z_]`) missed it too.
    it("treats a digit-leading name as an argument", () => {
      const message = "{1fast}";
      expect(icuArguments(message)).toStrictEqual(["1fast"]);

      const translate = createTranslator({
        locale: "en",
        messages: { Fixture: { greeting: message } },
        onError: (error) => {
          throw error;
        },
      }) as unknown as (
        key: string,
        values?: Record<string, string | number | Date>,
      ) => string;

      expect(() =>
        translate("Fixture.greeting", dummyIcuValues(message)),
      ).not.toThrow();
    });

    // Finding: the old regular expression also matched a `select` branch's
    // own one-word label or message body — `{Other}` inside `other {Other}`
    // — as if it were a top-level argument, so introducing any `select`
    // failed the name-comparison test on a phantom argument.
    it("does not mistake a select branch's own label or text for an argument", () => {
      const message = "{gender, select, male {He} female {She} other {Other}}";
      expect(icuArguments(message)).toStrictEqual(["gender"]);

      const translate = createTranslator({
        locale: "en",
        messages: { Fixture: { pronoun: message } },
        onError: (error) => {
          throw error;
        },
      }) as unknown as (
        key: string,
        values?: Record<string, string | number | Date>,
      ) => string;

      expect(() => translate("Fixture.pronoun", dummyIcuValues(message))).not.toThrow();
    });
  });
});

describe("the typed message keys", () => {
  // Three checks hold the catalog, the hand-written list above and MessageKey
  // together, and no two of them fail on the same mistake:
  //  - `MESSAGE_KEYS` is `as const satisfies readonly MessageKey[]` (above),
  //    so an entry the catalog does not hold — a typo, a key renamed or
  //    deleted in en.json — fails `pnpm typecheck`.
  //  - the `expectTypeOf` below fails `pnpm typecheck` when en.json gained a
  //    key nobody listed.
  //  - `names every key the catalog on disk holds, and no others` (below)
  //    catches the same omission but reads from the file on disk rather than
  //    from what the bundler resolved, so it *names* the offending key, and
  //    it is the only one that would notice DottedKeys and this file's own
  //    dottedKeys walk disagreeing.
  it("covers every MessageKey", () => {
    expectTypeOf<(typeof MESSAGE_KEYS)[number]>().toEqualTypeOf<MessageKey>();
  });

  it("names every key the catalog on disk holds, and no others", () => {
    expect([...MESSAGE_KEYS].sort()).toStrictEqual(referenceKeys);
  });
});
