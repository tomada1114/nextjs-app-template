import { useTranslations } from "next-intl";
import type { ReactElement } from "react";

import { Link } from "../../i18n/navigation";

/** The localized 404 rendered inside the locale layout's document shell. */
export default function LocaleNotFound(): ReactElement {
  const t = useTranslations("NotFound");

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-8">
      <h1>{t("title")}</h1>
      <p>{t("description")}</p>
      <Link href="/">{t("homeLink")}</Link>
    </main>
  );
}
