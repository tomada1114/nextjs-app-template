---
name: building-screens
description: >
  Covers the states a screen under src/app/[locale]/ renders and a test covers -
  loading.tsx or a Suspense fallback, error.tsx with retry, not-found.tsx and
  notFound(), an empty state, a failed form action keeping its input - and the
  accessibility each one owes: accessible names from the catalog, keyboard reach, focus,
  live regions, nothing by color alone, and getByRole queries. Use when building a
  screen or a form, adding an error.tsx, loading.tsx or global-error.tsx, writing an
  empty or error message, or reviewing a screen for accessibility.
---

# Building Screens

**Owns:** which states a screen renders, where each one lives in the App Router tree,
and what a screen owes a reader who does not use a mouse or does not see the color.
**Does not own:** which file is a Server or a Client Component (`building-app-routes`);
the tokens, focus ring, motion, contrast and the human review (`designing-ui`); the
catalog keys a screen reads (`localizing-ui`); the body and file of the tests below
(`writing-tests`, `placing-tests`); the order of work (`tdd`).

A screen that renders only its happy path passes every gate here. `pnpm build` never
throws inside a page on purpose, and no test fails because an error boundary is missing:
the framework's default renders instead, in English, whatever the locale. So list the
states before the first line of markup, and give each one a test.

## The states, and where each lives

| State          | The App Router mechanism                                  | Which side of the boundary                      |
| -------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Loading        | `loading.tsx` beside the page, or a `<Suspense>` fallback | Server; a pending control is client             |
| Failed         | `error.tsx` beside the page, with a retry                 | Client — an error boundary always is            |
| Not found      | `notFound()` from the page, rendered by `not-found.tsx`   | Server; `src/app/[locale]/not-found.tsx` exists |
| Empty          | The page itself: a ready state with nothing in it         | Whichever side renders the data                 |
| Failed action  | The form or button that made the request                  | Client: it owns the input and the pending state |
| Ready (normal) | The page                                                  | Server unless it needs the client               |

**REQUIRED:** `building-app-routes` › The Server / Client boundary before adding the
directive any row above calls for — it goes on the smallest file that needs it, never on
a layout.

## Loading

- A segment's `loading.tsx` wraps its page in a Suspense boundary; a slower part of a
  page gets its own `<Suspense>` instead, so the rest renders. The layout above is not
  inside that boundary.
- A wait inside a Client Component — a submitted form — is a pending state on the
  control that started it: disabled against a second submit, its label saying what is
  happening. `designing-ui`'s craft rules hold the one shared inline status a wait uses.
- Mark a wait for assistive technology: `role="status"` on the region that says it, so
  the change is announced without moving focus.

## Failed: `error.tsx`

- It carries `"use client"`, takes `{ error, retry }`, and offers `retry` as a button.
  Since Next.js 16.3, `retry` re-fetches and re-renders the segment; `reset` only clears
  the boundary without re-fetching, so a retry wired to `reset` can show the same
  failure again (observed in
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`,
  Next.js 16.3.4, 2026-10-01).
- Render catalog copy, never `error.message` or `error.digest`. In production a Server
  Component's error reaches the boundary with a generic message by design, and a client
  error's message can carry anything the code put in it.
- `src/app/[locale]/error.tsx` sits inside `src/app/[locale]/layout.tsx`'s
  `NextIntlClientProvider`, so `useTranslations` works there. It does not catch an error
  thrown by that layout itself.
- An error thrown by a layout reaches the `error.tsx` of the segment above it, outside
  that layout's provider. Above `[locale]` that is the root, whose layout renders no
  `<html>`, so a `src/app/error.tsx` brings its own shell as `src/app/not-found.tsx`
  does. One thrown by `src/app/layout.tsx` reaches only `src/app/global-error.tsx`,
  which replaces the root layout: it renders its own `<html>` and `<body>`, has no
  provider above it, and does not inherit `globals.css`. The template's root boundary
  reads catalog copy directly, using the URL's locale after hydration and the default
  locale on the server. Its global boundary reuses that document and imports the
  stylesheet explicitly, so recovery depends on neither the failed provider nor the
  failed layout.

## Not found and empty

- A missing record calls `notFound()` from the page, which renders the nearest
  `not-found.tsx`. Never render an empty page with a 200 for a URL that names nothing.
- Empty is a ready state, not a loading or a failed one: it says there is nothing yet
  and offers the next action — the control that creates the first item, or a link to
  where items come from. A blank region with no sentence is the failure.

## Failed action

A form that calls a Route Handler owns this state, and it has three duties:

- **Keep the input.** A failure never clears the field or navigates away; the reader
  fixes or retries what they wrote.
- **Say why, from the catalog.** Branch on the response's `error.code`, never on its
  message: map each code to a message key with an `as const satisfies` table, so a new
  code fails to compile until it has copy. The code union lives in `src/core/`, where
  both the handler and a component can import it. **BACKGROUND:** `designing-errors` for
  why a message is not a contract.
- **Announce it.** Render the message in a `role="alert"` region next to the control,
  and re-enable the control. Do not move focus to the message; the alert is read where
  focus already is.

## Accessibility

What follows is what a rendered test can check. Contrast is measured, not judged —
**REQUIRED:** `designing-ui` › Measuring contrast. Focus ring, reduced motion and mobile
width are its craft rules, and only its human review sees them.

- **Every control has an accessible name.** Prefer visible text: a `<label>` tied to its
  field, a button's own words. A control with no visible text — an icon button, a
  landmark — takes an `aria-label` from the catalog; `src/app/[locale]/page.tsx`'s
  `<nav aria-label>` is the example. A placeholder is not a label.
- **Native elements first.** `<button>` for an action, `<a>`/`Link` for navigation,
  `<input>` with a `<label>` for a field. They are keyboard-reachable and announce their
  role for free; a `<div onClick>` is neither. Never set a positive `tabIndex`.
- **Structure a reader can navigate.** One `<h1>` per screen, headings in order, and
  landmarks (`<main>`, `<nav>`) as the existing pages use them.
- **Nothing by color alone.** A status, an invalid field or the current item carries a
  word, an icon with a name, or `aria-current`/`aria-invalid` beside its color.
- **The document language comes from the locale layout's `<html lang>`.** A fragment in
  another language sets its own `lang`.

## Strings

Every string a state renders comes from a catalog — the loading label, the error and
retry copy, the empty sentence and its action, every `aria-label`. A hard-coded English
fallback is the bug this skill exists for, not a placeholder. **REQUIRED:**
`localizing-ui` for adding the keys to every catalog and to `MESSAGE_KEYS`.

## Verifying a screen

- One rendered test per state, under jsdom, querying by role and accessible name with
  the name read from the catalog: `getByRole("button", { name: en.Namespace.retry })`,
  `getByRole("alert")`, `getByRole("status")`. A query that only finds the element by
  class or test id proves nothing about its name. **REQUIRED:** `writing-tests`.
- An `error.tsx` is a synchronous Client Component: render it directly with an `error`
  and a recording `retry`, click the button, and assert it was called. A failed action
  renders the component with an injected failing response and asserts the alert's text
  and that the field still holds its value.
- An asynchronous Server Component is not rendered under jsdom — `building-app-routes`
  explains why — so a `loading.tsx` or page that awaits is checked by
  `pnpm build && pnpm test:smoke`, and by opening it.
- jsdom computes no layout, focus ring or contrast. Those are `designing-ui`'s
  "Reviewing a screen", the agent part and the human part.
- No axe, no browser and no E2E harness, deliberately — the same decision
  `tests/server-smoke.test.ts` records. Proposing one is a dependency and a gate change,
  not part of a screen.

## Checklist

- [ ] Loading, failed, not found, empty and any failed action each render, and each has
      a test.
- [ ] `error.tsx` is a Client Component that offers `retry` and renders catalog copy.
- [ ] Every control has an accessible name from the catalog and is a native element.
- [ ] No state is shown by color alone; a wait is `role="status"`, a failure
      `role="alert"`.
- [ ] Every new string is in every catalog.
- [ ] `designing-ui`'s review ran, and the pull request says what was not reviewed.
