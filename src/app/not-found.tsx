import { getLocale } from "next-intl/server";
import type { ReactElement } from "react";

import { MESSAGES } from "../i18n/messages";

/** The shelled fallback for framework-level misses outside a locale shell. */
export default async function RootNotFound(): Promise<ReactElement> {
  const locale = await getLocale();
  const messages = MESSAGES[locale].NotFound;

  return (
    <html lang={locale}>
      <body>
        <main>
          <h1>{messages.title}</h1>
          <p>{messages.description}</p>
          <a href={`/${locale}`}>{messages.homeLink}</a>
        </main>
      </body>
    </html>
  );
}
