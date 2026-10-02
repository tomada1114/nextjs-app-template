import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RootError from "../src/app/error";
import GlobalError from "../src/app/global-error";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

describe.each([RootError, GlobalError])("a document error boundary", (Boundary) => {
  it("renders on the server with no browser or translation provider", () => {
    vi.stubGlobal("location", undefined);
    const error = new Error("private server information");
    const markup = renderToStaticMarkup(
      <Boundary error={error} retry={() => undefined} />,
    );
    const doc = new DOMParser().parseFromString(markup, "text/html");
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.title).toBe(en.ErrorBoundary.title);
    expect(doc.body.textContent).toContain(en.ErrorBoundary.description);
    expect(doc.body.textContent).not.toContain(error.message);
  });

  it.each(["en", "ja", "unknown"] as const)(
    "renders and recovers without a translation provider on /%s",
    (locale) => {
      vi.stubGlobal("location", { pathname: `/${locale}/failed-page` });
      const doc = document;
      let retries = 0;
      const error = Object.assign(new Error("private database information"), {
        digest: "private-digest",
      });
      const rendered = render(
        <Boundary
          error={error}
          retry={() => {
            retries += 1;
          }}
        />,
        { container: doc },
      );
      const messages = locale === "ja" ? ja.ErrorBoundary : en.ErrorBoundary;

      expect(doc.documentElement.lang).toBe(locale === "ja" ? "ja" : "en");
      expect(doc.title).toBe(messages.title);
      expect(rendered.getByRole("heading", { level: 1 })).toHaveTextContent(
        messages.title,
      );
      expect(rendered.getByRole("alert")).toHaveTextContent(messages.description);
      expect(doc.body.textContent).not.toContain(error.message);
      expect(doc.body.textContent).not.toContain(error.digest);
      fireEvent.click(rendered.getByRole("button", { name: messages.retry }));
      expect(retries).toBe(1);
    },
  );
});
