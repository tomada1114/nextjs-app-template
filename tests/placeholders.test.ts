import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The template ships with its identity written out as placeholder strings —
// a package name, a repository slug, an author, a one-line description — which
// whoever starts an app from it replaces. `scripts/bootstrap.mjs` used to hold
// both halves of that: the rewrite and the check that no placeholder survived
// it. Issue #26 removed the rewrite (it was profile-driven machinery that
// self-deleted), and the check went with it, leaving nothing that notices a
// placeholder leaking into a file that has no business carrying one.
//
// This is that check, rebuilt as a test over the real tree. It pins the
// complete inventory rather than merely forbidding placeholders: a new file
// that picks one up fails, and so does an inventory entry that has gone stale,
// which is what makes this list usable as the rename checklist a new app
// works through.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every string that names *this template* rather than a project built from it.
 *
 * @remarks
 * `you@example.com` is listed although nothing carries it today: it is one of
 * the identity strings the template has used, and an author field
 * reintroducing it should fail here rather than ship. A token that matches
 * nothing simply contributes no rows to the inventory below.
 */
const PLACEHOLDERS = [
  "my-package",
  "your-name",
  "Your Name",
  "you@example.com",
  "A short description.",
] as const;

/**
 * The complete inventory of where a placeholder still stands, as
 * `<file>: <placeholder>` rows.
 *
 * @remarks
 * These four files *are* the template's identity, so a placeholder in them is
 * intended, not a leak: they are what a new app rewrites first. Everything
 * else in the tree — `src/`, `tests/`, `scripts/`, the skills, the workflows,
 * `CONTRIBUTING.md`, `AGENTS.md` — must name nothing of the sort, so the
 * rename is a bounded edit to four files rather than a repository-wide search
 * that can miss one.
 */
const EXPECTED_INVENTORY = [
  ".github/ISSUE_TEMPLATE/config.yml: my-package",
  ".github/ISSUE_TEMPLATE/config.yml: your-name",
  "LICENSE: Your Name",
  "README.md: A short description.",
  "README.md: Your Name",
  "README.md: my-package",
  "README.md: your-name",
  "package.json: A short description.",
  "package.json: my-package",
];

// Directories with nothing hand-written in them: dependencies, version control
// internals, build and coverage output, data under test (a fixture is
// committed precisely because it is odd), and the full checkouts an agent
// session leaves behind, which are scanned in their own checkout.
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
 * Whether the walk must not read `name`.
 *
 * @remarks
 * `.env` and any real environment file are off limits outright (AGENTS.md's
 * "Security and human approval"); the tracked example variants are the
 * exception and are scanned like any other file.
 */
function isOffLimits(name: string): boolean {
  if (!name.startsWith(".env")) {
    return false;
  }
  return ![".env.example", ".env.sample", ".env.template"].includes(name);
}

/** Every readable, hand-written file in the tree, as repo-relative paths. */
function walk(directory: string): string[] {
  const absolute = directory === "" ? repoRoot : path.join(repoRoot, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(relative);
    }
    if (!entry.isFile() || SKIPPED_FILES.has(entry.name) || isOffLimits(entry.name)) {
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

const scanned = walk("").filter((relative) => relative !== THIS_FILE);

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

  it("survive only in the four files that carry the template's identity", () => {
    expect(inventory).toStrictEqual(EXPECTED_INVENTORY);
  });
});
