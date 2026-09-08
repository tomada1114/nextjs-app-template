import createMiddleware from "next-intl/middleware";

import { routing } from "./i18n/routing";

/**
 * Locale detection, at the edge of every page request.
 *
 * @remarks
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`; this is that file, and
 * `next-intl`'s middleware factory is what fills it. It sits inside `src/`
 * rather than at the repository root because that is where Next.js looks for
 * it in a project whose App Router tree is `src/app/` — at the root it is
 * simply never loaded, and every unprefixed path 404s with the build still
 * green. It reads the request's
 * `Accept-Language` header and its locale cookie, then redirects a path with no
 * locale prefix — `/` above all — to one that has it.
 */
export default createMiddleware(routing);

/**
 * The paths locale detection runs on.
 *
 * @remarks
 * Everything except API routes, the framework's own asset trees, and any path
 * with a file extension: none of those is a page, so prefixing one with a
 * locale would only break it. This pattern and the `[locale]` segment have to
 * agree — a page path the proxy skips never gets a prefix and 404s against the
 * segment, with nothing else in the tree noticing — so `tests/proxy.test.ts`
 * asserts both halves.
 */
export const config = {
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
