import { hasLocale, useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { use, type ReactElement } from "react";

import { LOCALES } from "../../i18n/locales";
import { Link } from "../../i18n/navigation";

/**
 * The one page this template ships, translated.
 *
 * @remarks
 * The locale links are the smallest honest language switch: `Link` from
 * `src/i18n/navigation.ts` adds the locale prefix to the unprefixed pathname
 * it is given, so `/ja` is reachable from `/en` without the reader typing a
 * URL. The pathname here is the literal `/` rather than the current one — the
 * template ships a single page; a switcher on a tree of pages would read
 * `usePathname()` from the same module instead.
 */
export default function HomePage({
  params,
}: Readonly<{
  params: Promise<{ locale: string }>;
}>): ReactElement {
  const { locale } = use(params);
  if (!hasLocale(LOCALES, locale)) {
    notFound();
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by next-intl's legacy static-rendering API
  setRequestLocale(locale);

  const t = useTranslations("HomePage");
  const switcher = useTranslations("LocaleSwitcher");

  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("intro", { language: switcher(locale) })}</p>
      <p>{t("localeCount", { count: LOCALES.length })}</p>
      <nav aria-label={switcher("label")}>
        <ul>
          {LOCALES.map((candidate) => (
            <li key={candidate}>
              <Link href="/" locale={candidate} hrefLang={candidate}>
                {switcher(candidate)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
