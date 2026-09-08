import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkRead } from "../scripts/lib/guard/paths.mjs";

// Several suites here assert against the files on disk rather than against
// imported code, and each of them needs the same thing first: every readable,
// hand-written file in the checkout. The walk was written twice before this
// module existed and a third copy was about to be written; a scan rule that
// exists in three places is one that gets fixed in one of them.
//
// This file holds no assertion of its own. The synthetic-tree cases that pin
// what the walk must never return live in the suites that call it.

/** The repository root, which every path this module returns is relative to. */
export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Names with nothing hand-written under them: dependencies, version-control
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
// outside any `it()`, so a suite errors out instead of failing.
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

// Generated files and tool caches: nothing here is authored, and anything a
// caller scans for could only appear in one as an echo of a file that *is*
// authored.
const SKIPPED_FILES = new Set([
  "pnpm-lock.yaml",
  ".eslintcache",
  ".DS_Store",
  "next-env.d.ts",
]);

/**
 * Every readable, hand-written file under `root`, as root-relative paths.
 *
 * @remarks
 * What must never be read — `.env*`, `.envrc*`, anything under `secrets/`, and
 * the personal `.claude/settings.local.json` — is decided by the one engine
 * `scripts/check-staged.mjs` already uses, not by a second list here:
 * AGENTS.md keeps a rule in exactly one place, and a copy of it here is the
 * copy that goes stale. `checkRead` judges a file by its whole path and stays
 * the rule of record; `SKIPPED_DIRECTORIES` names `secrets` on top of it only
 * so the directory is never enumerated.
 *
 * `root` is a parameter so the exclusions can be asserted over a synthetic
 * tree; a checkout with no `secrets/` in it would pass vacuously.
 */
export function walk(root: string, directory = ""): string[] {
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

/**
 * The text of a file in this repository, or `undefined` for a binary one.
 *
 * @remarks
 * A binary file cannot carry a textual reference, so every caller treats it as
 * having nothing to say rather than decoding it as UTF-8 and matching noise.
 */
export function readText(relative: string): string | undefined {
  const bytes = readFileSync(path.join(repoRoot, relative));
  return bytes.includes(0) ? undefined : bytes.toString("utf8");
}
