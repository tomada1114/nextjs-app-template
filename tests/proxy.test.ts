import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import proxy, { config } from "../proxy";
import { DEFAULT_LOCALE, LOCALES } from "../src/i18n/locales";

// The failure this file exists to catch is silent: `proxy.ts` decides which
// requests acquire a locale prefix, and `src/app/[locale]/` decides which
// prefixes render. Disagree, and `/` 404s — or `/api/ask` gets redirected to
// `/en/api/ask` — with every other suite still green, because nothing else in
// the repository reads both halves.

/**
 * `config.matcher` as a regular expression.
 *
 * @remarks
 * Next.js compiles the matcher itself; this is the same source read as a
 * whole-path pattern, which is exact for the negative-lookahead form used here
 * and is what makes the path decisions below assertable without booting a
 * server.
 */
const matcher = new RegExp(`^${config.matcher}$`);

/**
 * The path a proxy response redirects to, or `undefined` when it does not.
 *
 * @remarks
 * `Location` comes back absolute, and the origin is the one the test made the
 * request against — nothing the proxy decides — so only the path is asserted.
 */
function redirectTarget(response: Response): string | undefined {
  const location = response.headers.get("location");
  return response.status >= 300 && response.status < 400 && location !== null
    ? new URL(location).pathname
    : undefined;
}

function get(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers });
}

describe("the paths locale detection runs on", () => {
  it.each(["/", ...LOCALES.map((locale) => `/${locale}`), "/ja/nested/page"])(
    "runs on %s",
    (path) => {
      expect(matcher.test(path)).toBe(true);
    },
  );

  it.each([
    ["an API route", "/api/ask"],
    ["a framework asset", "/_next/static/chunk.js"],
    ["a deployment-platform path", "/_vercel/insights"],
    ["anything with a file extension", "/favicon.ico"],
  ])("leaves %s alone", (_label, path) => {
    expect(matcher.test(path)).toBe(false);
  });
});

describe("locale detection", () => {
  it("redirects an unprefixed path to the default locale", () => {
    expect(redirectTarget(proxy(get("/")))).toBe(`/${DEFAULT_LOCALE}`);
  });

  it("redirects to the locale the reader's browser asked for", () => {
    const target = redirectTarget(proxy(get("/", { "accept-language": "ja" })));

    expect(target).toBe("/ja");
  });

  it("falls back to the default locale for a language this app does not ship", () => {
    const target = redirectTarget(proxy(get("/", { "accept-language": "fr" })));

    expect(target).toBe(`/${DEFAULT_LOCALE}`);
  });

  it.each([...LOCALES])(
    "serves an already-prefixed /%s without redirecting",
    (locale) => {
      expect(redirectTarget(proxy(get(`/${locale}`)))).toBeUndefined();
    },
  );

  it("sends every redirect to a locale the [locale] segment can render", () => {
    const targets = ["/", "/nested"].map((path) => redirectTarget(proxy(get(path))));

    expect(targets).toStrictEqual(["/en", "/en/nested"]);
  });
});
