import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkRead } from "../scripts/lib/guard/paths.mjs";

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

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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
 * The last two are the app's display name — what a browser tab and the page
 * heading read — which the package name and the slug do not cover: a project
 * that renamed everything machine-facing still greets its visitors as this
 * template. The Japanese one is the single non-English string in this suite,
 * and unavoidably so: the needle for a catalog value can only be that value.
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
] as const;

/**
 * The complete inventory of where a placeholder still stands, as
 * `<file>: <placeholder>` rows.
 *
 * @remarks
 * These seven files *are* the template's identity, so a placeholder in them is
 * intended, not a leak: they are what a new app rewrites first. Four carry the
 * repository's identity — the package name and description, the slug, the
 * copyright holder — and three the name a visitor reads: the `<title>`
 * metadata and the `HomePage.title` key of each catalog. Everything else in
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
  "messages/ja.json: Next.js アプリテンプレート",
  "package.json: A short description.",
  "package.json: my-package",
  "src/app/[locale]/layout.tsx: Next.js App Template",
];

// Names with nothing hand-written under them: dependencies, version control
// internals, build and coverage output, data under test (a fixture is
// committed precisely because it is odd), and the full checkouts an agent
// session leaves behind, which are scanned in their own checkout.
//
// Matched by name whatever the entry turns out to be, not only when it is a
// directory: inside a linked git worktree `.git` is a *file* holding a
// `gitdir:` pointer, so a type-gated skip walks straight into what it means to
// exclude — and in an ordinary checkout that is a `.git/config` whose remote
// URL can carry a credential.
//
// `secrets` is named here as well, although `checkRead` already drops every
// entry inside it: without the name, the directory is still `readdirSync`'d,
// and a checkout that keeps it unreadable throws EACCES at module scope —
// outside any `it()`, so the suite errors out instead of failing.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "fixtures",
  "worktrees",
  ".idea",
  ".vscode",
  "secrets",
]);

// Generated files and tool caches: nothing here is authored, and a placeholder
// could only appear in one as an echo of a file that *is* authored.
const SKIPPED_FILES = new Set([
  "pnpm-lock.yaml",
  ".eslintcache",
  ".DS_Store",
  "next-env.d.ts",
]);

/**
 * This file, which necessarily spells out every placeholder it looks for.
 *
 * @remarks
 * Excluded by path rather than by some marker in the text, so the exclusion
 * cannot be copied into another file by accident.
 */
const THIS_FILE = "tests/placeholders.test.ts";

/**
 * Every readable, hand-written file under `root`, as root-relative paths.
 *
 * @remarks
 * What must never be read — `.env*`, `.envrc*`, anything under `secrets/` —
 * is decided by the guard engine `scripts/check-staged.mjs` already uses, not
 * by a second list here: AGENTS.md keeps a rule in exactly one place, and a
 * copy of it here is the copy that goes stale. `checkRead` judges a file by
 * its whole path and stays the rule of record; `SKIPPED_DIRECTORIES` names
 * `secrets` on top of it only so the directory is never enumerated.
 *
 * `root` is a parameter so the exclusions can be asserted over a synthetic
 * tree; a checkout with no `secrets/` in it would pass vacuously.
 */
function walk(root: string, directory = ""): string[] {
  const absolute = directory === "" ? root : path.join(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (SKIPPED_DIRECTORIES.has(entry.name) || checkRead(relative) !== null) {
      return [];
    }
    if (entry.isDirectory()) {
      return walk(root, relative);
    }
    if (!entry.isFile() || SKIPPED_FILES.has(entry.name)) {
      return [];
    }
    return entry.name.endsWith(".tsbuildinfo") || entry.name.endsWith(".log")
      ? []
      : [relative];
  });
}

/** `undefined` for a binary file, which cannot carry a placeholder as text. */
function readText(relative: string): string | undefined {
  const bytes = readFileSync(path.join(repoRoot, relative));
  return bytes.includes(0) ? undefined : bytes.toString("utf8");
}

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

describe("the walk that feeds the inventory", () => {
  // Every path the walk returns is opened by `readText`, so what it must *not*
  // return is a property of its own — and AGENTS.md counts the read itself as
  // the disclosure. Driven over a synthetic tree because a checkout usually has
  // no `secrets/` in it, and an assertion over the real one would then hold for
  // the wrong reason.
  const body = "placeholder body, nothing sensitive\n";
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "placeholders-walk-"));
    mkdirSync(path.join(root, "secrets"));
    for (const relative of [
      "secrets/token.txt",
      ".env",
      ".env.local",
      ".envrc",
      ".env.example",
      "README.md",
    ]) {
      writeFileSync(path.join(root, relative), body);
    }
    // What `.git` is inside a linked worktree: a pointer file, not a directory.
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/1\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not read anything under secrets/", () => {
    expect(walk(root)).not.toContain("secrets/token.txt");
  });

  it("does not read a linked worktree's .git, which is a file and not a directory", () => {
    expect(walk(root)).not.toContain(".git");
  });

  it("reads the tracked env example and no real dotenv or direnv file", () => {
    expect(walk(root).sort()).toStrictEqual([".env.example", "README.md"]);
  });
});
