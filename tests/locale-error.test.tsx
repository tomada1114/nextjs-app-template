import { NextIntlClientProvider } from "next-intl";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LocaleError from "../src/app/[locale]/error";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

// The error boundary is a synchronous Client Component, so it renders directly
// with an `error` and a recording `retry` — no segment has to throw first.
// `NextIntlClientProvider` stands in for the one `src/app/[locale]/layout.tsx`
// wraps the boundary in during a real request.

interface Rendered {
  retries: () => number;
}

function renderBoundary(
  locale: "en" | "ja",
  error: Error & { digest?: string } = new Error("boom"),
): Rendered {
  let count = 0;
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : ja}>
      <LocaleError
        error={error}
        retry={() => {
          count += 1;
        }}
      />
    </NextIntlClientProvider>,
  );
  return { retries: () => count };
}

describe("LocaleError", () => {
  it("names the failure in a heading and announces it as an alert", () => {
    renderBoundary("en");

    expect(
      screen.getByRole("heading", { level: 1, name: en.ErrorBoundary.title }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(en.ErrorBoundary.description);
  });

  it("calls retry once when the retry button is pressed", () => {
    const { retries } = renderBoundary("en");

    fireEvent.click(screen.getByRole("button", { name: en.ErrorBoundary.retry }));

    expect(retries()).toBe(1);
  });

  it("never renders the error's own message or digest", () => {
    const error = Object.assign(new Error("database password leaked"), {
      digest: "digest-1234",
    });
    renderBoundary("en", error);

    expect(screen.queryByText(/database password leaked/)).toBeNull();
    expect(screen.queryByText(/digest-1234/)).toBeNull();
  });

  it("renders the Japanese catalog's copy under ja", () => {
    renderBoundary("ja");

    expect(
      screen.getByRole("heading", { level: 1, name: ja.ErrorBoundary.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ja.ErrorBoundary.retry }),
    ).toBeInTheDocument();
  });
});
