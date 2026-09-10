import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement, ReactNode } from "react";

import { LOCALES } from "../../i18n/locales";

import "../globals.css";

export async function generateMetadata({
  params,
}: Readonly<{
  params: Promise<{ locale: string }>;
}>): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "Metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: {
      canonical: `/${locale}`,
      languages: Object.fromEntries(
        LOCALES.map((alternateLocale) => [alternateLocale, `/${alternateLocale}`]),
      ),
    },
  };
}

/**
 * The layout every page is rendered inside, one per locale.
 *
 * @remarks
 * This is where `<html lang>` lives rather than the root layout above it: the
 * language of the document is a property of the locale segment, and a root
 * layout renders for paths that have not got one yet.
 *
 * The `[locale]` segment is a catch-all, so an unknown value reaches here as a
 * locale. Answering that with a 404 is what stops `/nonsense` from rendering
 * the default locale's page under a URL nobody can link to twice.
 */
export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ locale: string }>;
}>): Promise<ReactElement> {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) {
    notFound();
  }

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
