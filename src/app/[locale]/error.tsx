"use client";

import { useTranslations } from "next-intl";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";

/**
 * The localized fallback for a render error thrown below the locale layout.
 *
 * @remarks
 * It renders catalog copy only, never `error.message` or `error.digest`: a
 * Server Component's message is generic in production, and a client error's can
 * carry anything. `retry` rather than `reset`, because only `retry` re-fetches
 * the segment; `reset` re-renders what already failed. An error thrown by
 * `src/app/[locale]/layout.tsx` itself never reaches this file — it sits inside
 * that layout's `NextIntlClientProvider`, which is why `useTranslations` works.
 */
export default function LocaleError({
  retry,
}: Readonly<{
  error: Error & { digest?: string };
  retry: () => void;
}>): ReactElement {
  const t = useTranslations("ErrorBoundary");

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-8">
      <h1>{t("title")}</h1>
      <p role="alert">{t("description")}</p>
      <Button type="button" onClick={retry}>
        {t("retry")}
      </Button>
    </main>
  );
}
