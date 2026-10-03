import { hasLocale, useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { use, type ReactElement } from "react";

import { Button } from "@/components/ui/button";

import { LOCALES } from "../../i18n/locales";
import { Link } from "../../i18n/navigation";

// Keep this page static without stripping request data from future siblings.
export const dynamic = "force-static";

/** Canonical URLs describe this page, rather than every child of the layout. */
export async function generateMetadata({
  params,
}: Readonly<{ params: Promise<{ locale: string }> }>): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) {
    notFound();
  }
  return {
    alternates: {
      canonical: `/${locale}`,
      languages: Object.fromEntries(
        LOCALES.map((candidate) => [candidate, `/${candidate}`]),
      ),
    },
  };
}

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
 *
 * Each link renders through `Button`'s `asChild`, which is the smallest
 * worked example of the `src/components/` zone: a Server Component page
 * handing a copied shadcn/ui component its content, with no `"use client"`
 * anywhere on the path.
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
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
      <h1>{t("title")}</h1>
      <p>{t("intro", { language: switcher(locale) })}</p>
      <p className="text-muted-foreground">
        {t("localeCount", { count: LOCALES.length })}
      </p>
      <nav aria-label={switcher("label")}>
        <ul className="flex flex-wrap gap-2">
          {LOCALES.map((candidate) => (
            <li key={candidate}>
              <Button asChild variant={candidate === locale ? "default" : "outline"}>
                <Link
                  href="/"
                  locale={candidate}
                  hrefLang={candidate}
                  lang={locale}
                  aria-current={candidate === locale ? "page" : undefined}
                >
                  {switcher(candidate)}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
