import { NextIntlClientProvider } from "next-intl";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HomePage from "../src/app/[locale]/page";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
}));

// The home page, rendered the way `writing-tests`/`placing-tests` settle it
// for issue #12: under jsdom, through Testing Library, with
// `NextIntlClientProvider` supplying the `locale`/`messages` context that
// `src/app/[locale]/layout.tsx` gets for free from the Server Component tree
// in a real request but a unit test must pass explicitly (see
// `NextIntlClientProvider`'s own `locale` doc comment). The page carries no
// `"use client"` — `building-app-routes` explains why hooks alone do not make
// it one — so what makes it renderable here is that it is synchronous, not
// that it runs on the client. An asynchronous Server Component —
// `LocaleLayout` itself — is explicitly out of scope; this test never renders
// it.

async function renderHomePage(locale: "en" | "ja" = "en"): Promise<void> {
  await act(async () => {
    render(
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : ja}>
        <HomePage params={Promise.resolve({ locale })} />
      </NextIntlClientProvider>,
    );
    await Promise.resolve();
  });
}

describe("HomePage", () => {
  it.each(["en", "ja"] as const)(
    "identifies the current %s language without relying on color",
    async (locale) => {
      await renderHomePage(locale);
      const english = screen.getByRole("link", {
        name: (locale === "en" ? en : ja).LocaleSwitcher.en,
      });
      const japanese = screen.getByRole("link", {
        name: (locale === "en" ? en : ja).LocaleSwitcher.ja,
      });
      expect(locale === "en" ? english : japanese).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(locale === "en" ? japanese : english).not.toHaveAttribute("aria-current");
      expect(english).toHaveAttribute("lang", "en");
      expect(japanese).toHaveAttribute("lang", "ja");
    },
  );
  it("renders under jsdom", () => {
    // Proves the `component` vitest project actually runs under jsdom, and
    // that `tests/**/*.test.ts` (the `unit`/`automation` projects) does not:
    // `tests/server-env.test.ts` and the rest of the `node`-environment suite
    // have no `document` to assert against.
    expect(typeof document).not.toBe("undefined");
  });

  it("renders the translated title and intro", async () => {
    await renderHomePage();

    expect(
      screen.getByRole("heading", { name: en.HomePage.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The App Router skeleton renders in English."),
    ).toBeInTheDocument();
  });

  it("renders a locale link for every shipped locale", async () => {
    await renderHomePage();

    const nav = screen.getByRole("navigation", { name: en.LocaleSwitcher.label });
    expect(nav).toBeInTheDocument();

    const english = screen.getByRole("link", { name: en.LocaleSwitcher.en });
    expect(english).toHaveAttribute("href", "/en");
    expect(english).toHaveAttribute("hreflang", "en");

    const japanese = screen.getByRole("link", { name: en.LocaleSwitcher.ja });
    expect(japanese).toHaveAttribute("href", "/ja");
    expect(japanese).toHaveAttribute("hreflang", "ja");
  });
});
