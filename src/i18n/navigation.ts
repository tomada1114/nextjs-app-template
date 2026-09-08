import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

/**
 * The locale-aware replacements for `next/link` and `next/navigation`.
 *
 * @remarks
 * Every one of these takes a pathname without the locale prefix — `/` rather
 * than `/en` — and adds the active locale on the way out. Using `next/link`
 * directly instead is the mistake this module exists to prevent: it produces a
 * URL with no locale, which `proxy.ts` then redirects, costing a round trip and
 * losing the locale the reader was already on.
 */
export const { Link, getPathname, redirect, usePathname, useRouter } =
  createNavigation(routing);
