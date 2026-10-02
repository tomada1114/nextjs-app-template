"use client";

import { useSyncExternalStore, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/i18n/locales";
import { MESSAGES } from "@/i18n/messages";

function browserLocale(): Locale {
  const segment = globalThis.location.pathname.split("/")[1];
  return LOCALES.find((locale) => locale === segment) ?? DEFAULT_LOCALE;
}

function serverLocale(): Locale {
  return DEFAULT_LOCALE;
}

// A document boundary is replaced on navigation, so its URL needs no listener.
function subscribe(): () => void {
  return () => undefined;
}

/**
 * A complete error document that survives a failed layout or translation provider.
 *
 * @remarks
 * Server rendering starts in the default locale; the URL supplies the client's
 * locale after hydration. Reading the catalogs directly keeps recovery available
 * even when next-intl or the router caused the error. Only catalog copy is shown:
 * an error's message and digest can contain private application information.
 */
export default function RootError({
  retry,
}: Readonly<{
  error: Error & { digest?: string };
  retry: () => void;
}>): ReactElement {
  const locale = useSyncExternalStore(subscribe, browserLocale, serverLocale);
  const copy = MESSAGES[locale].ErrorBoundary;

  return (
    <html lang={locale}>
      <head>
        <title>{copy.title}</title>
      </head>
      <body>
        <main className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-8">
          <h1>{copy.title}</h1>
          <p role="alert">{copy.description}</p>
          <Button type="button" onClick={retry}>
            {copy.retry}
          </Button>
        </main>
      </body>
    </html>
  );
}
