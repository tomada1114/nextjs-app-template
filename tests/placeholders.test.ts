import { describe, expect, it } from "vitest";

import { readText, repoRoot, walk } from "./repo-tree";

// The template ships with its identity written out as placeholder strings —
// a package name, a repository slug, an author, a one-line description, the
// name a visitor reads — which whoever starts an app from it replaces.
// `scripts/bootstrap.mjs` used to hold both halves of that: the rewrite and
// the check that no placeholder survived it. Issue #26 removed the rewrite
// (it was profile-driven machinery that self-deleted), and the check went
// with it, leaving nothing that notices a placeholder leaking into a file
// that has no business carrying one.
//
// This is that check, rebuilt as a test over the real tree. It pins the
// complete inventory rather than merely forbidding placeholders: a new file
// that picks one up fails, and so does an inventory entry that has gone stale,
// which is what makes this list usable as the rename checklist a new app
// works through. A new app replaces each site the inventory names below and
// deletes that row from EXPECTED_INVENTORY; it is finished when the list is
// empty and this suite is green — an empty list then means no identity string
// of this template survived. `starting-an-app` owns the order and the values
// to write in; this file owns the list.

/**
 * Every string that names *this template* rather than a project built from it.
 *
 * @remarks
 * `you@example.com` and `your-name` are listed although nothing carries them
 * today: they are identity strings the template has used, and a field
 * reintroducing either should fail here rather than ship. A token that
 * matches nothing simply contributes no rows to the inventory below.
 *
 * `tomada1114/nextjs-app-template` is not a blank like the others — it is
 * this template's real repository slug, and it names this template just as
 * literally as `my-package` does. A fork that keeps it points its CI badge
 * and its vulnerability-report link at someone else's repository. Only the
 * full slug is listed: a bare `tomada1114` would match
 * `tests/sync-labels.test.ts`'s `tomada1114/typescript-template` fixture
 * data, and a bare `nextjs-app-template` would produce a duplicate row per
 * file that carries the full slug.
 *
 * The last three are what a reader sees, which the package name and the slug
 * do not cover: a project that renamed everything machine-facing still greets
 * its visitors as this template. Two are the app's display name, one per
 * catalog language, together covering both the browser tab and the page
 * heading; the third is the one-line `description` metadata, which renders
 * into `<meta name="description">` and so into a search result and a link
 * preview. Coverage for the display name is per known
 * value, not per key: each entry is a catalog's current title string, so a
 * `messages/*.json` added later with its own translated title contributes no
 * row until that value is added to this list. The Japanese title and
 * description are needles AGENTS.md's Conventions allows a test to quote
 * verbatim: deriving them from `messages/ja.json` at runtime would make their
 * inventory rows self-fulfilling — they would still appear after a correct
 * rename, so the list could never empty.
 *
 * The home page's body copy — `HomePage.intro` and `HomePage.localeCount` in
 * each catalog — is deliberately absent. It is demo copy for a demo page a
 * project rewrites or deletes on day one, and `localizing-ui` quotes
 * `ja.json`'s `localeCount` as its worked example of plural categories, so a
 * needle for it would put inventory rows on a skill whose subject is ICU
 * plurals rather than this template's identity. `starting-an-app` sends a
 * renaming project to that copy by hand instead.
 */
const PLACEHOLDERS = [
  "my-package",
  "your-name",
  "Your Name",
  "you@example.com",
  "A short description.",
  "tomada1114/nextjs-app-template",
  "Next.js App Template",
  "Next.js アプリテンプレート",
  "An App Router skeleton.",
  "App Router のひな形です。",
] as const;

/**
 * The complete inventory of where a placeholder still stands, as
 * `<file>: <placeholder>` rows.
 *
 * @remarks
 * These seven files *are* the template's identity, so a placeholder in them is
 * intended, not a leak: they are what a new app rewrites first. Four carry the
 * repository's identity — the package name and description, the slug, the
 * copyright holder — and four the copy a visitor reads: the localized metadata
 * and `HomePage.title` keys in each catalog. Everything else in
 * the tree — the rest of `src/`, `tests/`, `scripts/`, the skills, the
 * workflows, `CONTRIBUTING.md`, `AGENTS.md` — must name nothing of the sort,
 * so the rename is a bounded edit to seven files rather than a
 * repository-wide search that can miss one. Two of the rows are the template's
 * real repository slug rather than a blank, deliberately: the CI badge and the
 * security-advisory link have to resolve *while this repository is the
 * template*, and a fork replaces them like any other row.
 */
const EXPECTED_INVENTORY = [
  ".github/ISSUE_TEMPLATE/config.yml: tomada1114/nextjs-app-template",
  "LICENSE: Your Name",
  "README.md: A short description.",
  "README.md: Your Name",
  "README.md: my-package",
  "README.md: tomada1114/nextjs-app-template",
  "messages/en.json: Next.js App Template",
  "messages/en.json: An App Router skeleton.",
  "messages/ja.json: Next.js アプリテンプレート",
  "messages/ja.json: App Router のひな形です。",
  "package.json: A short description.",
  "package.json: my-package",
];

/**
 * This file, which necessarily spells out every placeholder it looks for.
 *
 * @remarks
 * Excluded by path rather than by some marker in the text, so the exclusion
 * cannot be copied into another file by accident.
 */
const THIS_FILE = "tests/placeholders.test.ts";

const scanned = walk(repoRoot).filter((relative) => relative !== THIS_FILE);

const inventory = scanned
  .flatMap((relative) => {
    const text = readText(relative);
    return text === undefined
      ? []
      : PLACEHOLDERS.filter((placeholder) => text.includes(placeholder)).map(
          (placeholder) => `${relative}: ${placeholder}`,
        );
  })
  .sort();

describe("the template's own identity strings", () => {
  // An inventory test is only as good as the tree it walked, so the walk is
  // pinned first: a skip list that grew too broad would otherwise turn this
  // file into a test that scans almost nothing and passes.
  it.each([
    "README.md",
    "package.json",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "src/app/[locale]/page.tsx",
    "src/core/result.ts",
    "scripts/check-staged.mjs",
    ".github/workflows/ci.yml",
    ".agents/skills/changing-gates/SKILL.md",
    ".claude/skills/changing-gates/SKILL.md",
  ])("are looked for in %s", (relative) => {
    expect(scanned).toContain(relative);
  });

  it("are not looked for in this file, which has to name every one of them", () => {
    expect(scanned).not.toContain(THIS_FILE);
  });

  it("survive only in the files that carry the template's identity", () => {
    expect(inventory).toStrictEqual(EXPECTED_INVENTORY);
  });
});

describe("the badge and advisory URLs", () => {
  // The inventory above only proves the slug appears *somewhere* in each file;
  // it would pass on a badge URL missing its workflow filename. This pins both
  // URLs by their shape instead — path segments and filename — with owner and
  // repository left open on purpose: a renamed project writes its own slug in,
  // and pinning this template's would make the rename `starting-an-app`
  // documents impossible to finish with a green suite. The slug itself is the
  // inventory's job, one row per file.
  it.each([
    [
      "README.md",
      /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/workflows\/ci\.yml/,
    ],
    [
      ".github/ISSUE_TEMPLATE/config.yml",
      /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/security\/advisories\/new/,
    ],
  ])("%s carries a well-formed repository URL", (relative, pattern) => {
    expect(readText(relative)).toMatch(pattern);
  });
});
