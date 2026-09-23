import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cn } from "@/components/lib/utils";
import { Button } from "@/components/ui/button";

// The component copied in from the shadcn/ui registry, and the `cn` every
// such component calls. What is asserted is the wiring, not the styling: that
// the `@/` alias resolves under Vitest as well as under `tsc` and the Next.js
// build (this file imports through it on purpose), and that a caller's own
// `className` wins over the component's default, which is the one behaviour
// of `cn` a component's appearance depends on. No class list is pinned beyond
// that — a test restating one would fail on every legitimate restyle, which is
// `designing-ui`'s subject, not this file's.

describe("cn", () => {
  it("lets the later of two conflicting Tailwind utilities win", () => {
    expect(cn("p-2", "p-8")).toBe("p-8");
  });

  it("keeps utilities that do not conflict, and drops falsy input", () => {
    expect(cn("flex", false, undefined, "p-8")).toBe("flex p-8");
  });

  it("keeps a default size beside a theme color, since the two do not conflict", () => {
    expect(cn("text-sm", "text-muted-foreground")).toBe(
      "text-sm text-muted-foreground",
    );
  });
});

describe("Button", () => {
  it("renders a button carrying its slot as a data attribute", () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "data-slot",
      "button",
    );
  });

  it("renders the child element instead of a button when asChild is set", () => {
    render(
      <Button asChild>
        <a href="/">Return to the home page</a>
      </Button>,
    );

    expect(
      screen.getByRole("link", { name: "Return to the home page" }),
    ).toHaveAttribute("data-slot", "button");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets a caller's className override the component's own default", () => {
    render(<Button className="px-8">Save</Button>);

    const { className } = screen.getByRole("button");
    expect(className).toContain("px-8");
    expect(className).not.toContain("px-4");
  });

  it("applies the variant it is given instead of the default one", () => {
    render(<Button variant="outline">Save</Button>);

    const { className } = screen.getByRole("button");
    expect(className).toContain("border");
    expect(className).not.toContain("bg-primary");
  });
});
