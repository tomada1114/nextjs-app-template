import { NextIntlClientProvider } from "next-intl";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "../src/app/[locale]/page";
import en from "../messages/en.json";

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

function renderHomePage(): void {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <HomePage />
    </NextIntlClientProvider>,
  );
}

describe("HomePage", () => {
  it("renders under jsdom", () => {
    // Proves the `component` vitest project actually runs under jsdom, and
    // that `tests/**/*.test.ts` (the `unit`/`automation` projects) does not:
    // `tests/server-env.test.ts` and the rest of the `node`-environment suite
    // have no `document` to assert against.
    expect(typeof document).not.toBe("undefined");
  });

  it("renders the translated title and intro", () => {
    renderHomePage();

    expect(
      screen.getByRole("heading", { name: en.HomePage.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The App Router skeleton renders in English."),
    ).toBeInTheDocument();
  });

  it("renders a locale link for every shipped locale", () => {
    renderHomePage();

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
