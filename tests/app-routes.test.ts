import { describe, expect, it, vi } from "vitest";

import * as layout from "../src/app/[locale]/layout";
import * as home from "../src/app/[locale]/page";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: ({ locale }: { locale: "en" | "ja" }) =>
    Promise.resolve(
      (key: "title" | "description") => (locale === "en" ? en : ja).Metadata[key],
    ),
}));

describe("the locale page tree", () => {
  it("lets future child pages use request data", () => {
    expect(layout).not.toHaveProperty("dynamic");
    expect(home).toHaveProperty("dynamic", "force-static");
  });

  it.each(["en", "ja"] as const)(
    "keeps shared %s metadata free of the home page's canonical URL",
    async (locale) => {
      const metadata = await layout.generateMetadata({
        params: Promise.resolve({ locale }),
      });
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.title).toBe((locale === "en" ? en : ja).Metadata.title);
    },
  );

  it.each(["en", "ja"] as const)(
    "publishes canonical and language alternatives on the %s home page",
    async (locale) => {
      expect(home).toHaveProperty("generateMetadata");
      const metadata = await home.generateMetadata({
        params: Promise.resolve({ locale }),
      });
      expect(metadata.alternates).toEqual({
        canonical: `/${locale}`,
        languages: { en: "/en", ja: "/ja" },
      });
    },
  );
});
