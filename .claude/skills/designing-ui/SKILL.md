---
name: designing-ui
description: >
  Covers this app's visual language and the Tailwind v4 + shadcn/ui foundation under it:
  the design-direction lock, the tokens in src/app/globals.css, adding a shadcn/ui
  component with pnpm dlx shadcn@latest add into src/components/ui/, cn and
  tailwind-merge, dark mode, and the Preflight traps. Use when building or restyling a
  component or page, choosing a color, type size, radius, spacing or motion, adding or
  renaming a theme token, running the shadcn CLI, or when the design direction is still
  unsettled in a fresh copy of the template.
---

# Designing UI

**Owns:** the visual direction and its lock, the theme tokens in `src/app/globals.css`,
how a shadcn/ui component enters `src/components/`, and the craft rules every screen
follows. **Does not own:** which zone a component may import from (`building-app-routes`
and AGENTS.md's Architecture); the TypeScript inside a component (`writing-typescript`);
the text a component renders (`localizing-ui`); settling the direction for a new app the
first time (`starting-an-app`).

Nothing here is enforced by a config or a test. A drifted screen passes every gate, so
the lock below is the check: read it before styling, and compare the rendered screen
against it afterwards.

## The lock

DESIGN DIRECTION: UNSETTLED.

The template ships no design direction. `src/app/globals.css` carries shadcn/ui's stock
`neutral` tokens so a copied component renders on day one, and that is all they are —
not a choice anyone made. While this marker stands, style only with the existing tokens
and the registry's own classes; do not pick a palette, a typeface or a layout by taste
to get a screen done. In a project started from the template, stop and say the direction
is unsettled, then settle it through `starting-an-app` before the first real screen.

Settling it replaces the marker with a filled lock of this shape, researched rather than
invented, and locked — a later screen adapts to it rather than renegotiating it:

```text
Primary reference:  the one product whose visual system this app follows, and why.
Preserve:           what is kept from it — canvas, type roles, rules vs. shadows, radii,
                    density, the column.
Borrow only:        the specific pieces taken from a second reference, and nothing else.
Role rules:         which color means what, stated once — the primary action, a status.
Media strategy:     photography, illustration and graphics allowed, or ruled out.
Reject:             the genre defaults this app will not ship.
Memorable move:     the one thing a reader should remember about the screen.
```

Follow it with a ledger — one row per decision a reader would otherwise take on trust:
the decision, its source, and why. Then replace the stock values in `globals.css` and
record the component recipes (primary action, field, card) in a `references/` file next
to this one.

## Foundation

Tailwind v4 with no `tailwind.config.js`: `postcss.config.mjs` is the whole of the build
wiring, and the theme is CSS. Tokens are declared once in `globals.css` and consumed as
utilities; a component never carries a raw color, a one-off `px` type size, or an
arbitrary-value color.

- `components.json` points every shadcn alias inside one zone — `@/components`,
  `@/components/ui`, `@/components/lib`, `@/components/lib/utils`, `@/components/hooks`
  — so the CLI writes into `src/components/` and nowhere else.
- `pnpm dlx shadcn@latest …` cannot run from the repository root: the CLI's own
  dependency graph reaches a package that `pnpm-workspace.yaml`'s `trustPolicy` refuses.
  Run it from a scratch directory outside the checkout and point it back with
  `-c <path to this checkout>`, so the component lands in `src/components/` while
  nothing installed into the repository bypasses the policy. Any package the component
  needs is then added with `pnpm add` here, under the review `managing-dependencies`
  owns.
- Rewrite the copy's imports on the way in: `cn` from `@/components/lib/utils`, and
  `Slot` from `@radix-ui/react-slot` rather than the `radix-ui` umbrella, which pulls
  every Radix primitive in for one. Give the props an `interface` and the function an
  explicit return type. `src/components/ui/button.tsx` is the worked example, and its
  header lists exactly that diff.
- A copied component is ordinary source to edit, not a dependency to configure around.
  Once the lock is settled, restyle each copy to it on the way in — an untouched default
  carries the stock palette and radius, which is exactly the drift this skill prevents.
- Prefer a registry component over a hand-rolled one. The lock's reject list still
  applies to a component that ships inside a library.

## Tokens

- The shape is shadcn's: a plain custom property on `:root` per color, mapped onto a
  utility by `@theme inline`. `inline` makes the utility read the property itself, which
  is what lets one media query swap every value.
- Dark mode follows `prefers-color-scheme` and nothing else — Tailwind v4's default
  `dark:` variant is the same media query. shadcn's `.dark` class is not used, because
  nothing sets it; a project that adds a theme toggle moves the dark values under a
  selector and redeclares the variant with `@custom-variant dark`.
- A token declared directly in a plain `@theme` block is emitted only once some utility
  uses it, so `var()` against an unused one from hand-written CSS resolves to nothing.
  Declare such a block `@theme static` when raw CSS reads the tokens too.
- Never give a size token and a color token the same name. With `--color-body` and
  `--text-body` both declared, a bare `text-body` always resolves to the color, and the
  size is reachable only through `text-[length:var(--text-body)]`.
- `twMerge` knows only Tailwind's default theme. A custom `--text-*` size is filed with
  the colors, so `cn("text-figure", "text-muted-foreground")` silently drops the size.
  Adding one means switching `src/components/lib/utils.ts` to `extendTailwindMerge` with
  `extend.theme.text` naming it, plus a `cn` case in `tests/ui-primitives.test.tsx` that
  keeps the size beside a color.
- Measure a new text/background pairing against WCAG contrast rather than estimating it;
  placeholder and disabled colors never carry a label.

## Craft rules

- Preflight resets headings, links and margins. `globals.css` restores heading sizes and
  link underlines in `@layer base`, and deliberately does not restore a `<p>` margin: a
  base margin leaks into every caption set beside a button in a flex row. Space with the
  container's `gap-*`, not with margins on the children.
- Tailwind v4's Preflight also gives a button `cursor: default`; the base layer restores
  the pointer for enabled buttons. Keep that rule rather than adding `cursor-pointer`
  per component.
- Focus is visible on every control; never remove a ring to tidy a field.
- Motion is functional and short, and `prefers-reduced-motion` collapses all of it. A
  wait state is one shared inline status, not a new spinner per screen.
- Mobile is not a later pass: the column is fluid with a 16px gutter below the first
  breakpoint, and no screen scrolls horizontally.

## A screen with no precedent here

Do not extrapolate from taste. Research the surface the way the direction was
researched, then adapt the findings to the lock rather than letting them relax it. If a
finding and the lock genuinely conflict, say so and let a human decide which gives way —
quietly softening the lock toward a safer middle is the failure this file guards
against. The user-level `refero-design` skill is the research method when it is
installed.
