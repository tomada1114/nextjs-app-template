#!/usr/bin/env node
// Remove build output without depending on a shell or an extra package.
// Only paths passed on the command line are removed, and only when they sit
// inside the repository. Containment is checked twice — once on the resolved
// string, and once more after symlinks on the way to the target have been
// followed — so neither a typo nor a directory symlink pointing out of the
// checkout reaches past the project. Two things that guarantee does not
// cover, stated rather than left to be discovered: a target whose own final
// component is a symlink is still accepted, because `rmSync` unlinks the link
// and never follows it, so what disappears is the link and not what it points
// at; and the check runs before the removal, so a symlink swapped in between
// the two would not be seen.
// Node globals are imported explicitly rather than declared as ESLint globals:
// one convention for every .mjs file here, and no extra dependency.
import console from "node:console";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalize,
  errnoCode,
  escapes,
  UnresolvablePathError,
} from "./lib/clean-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Print the stderr report for a target that will not be removed.
 *
 * @param {string} code - Stable `ERR_CLEAN_*` identifier.
 * @param {string} target - The path as it was given on the command line.
 * @param {string} expected - What a target has to be.
 * @param {string} actual - What this one turned out to be.
 * @returns {void}
 */
function reportRefusal(code, target, expected, actual) {
  console.error(
    `${code}: refusing to remove a path outside the repository: ${target}\n` +
      `Expected: ${expected}\n` +
      `Actual: ${actual}\n` +
      "Next: pass a path inside the repository, and check every directory on " +
      "the way to it for a symlink leading out of the checkout.",
  );
}

/**
 * Print the stderr report for a target whose containment could not be
 * verified because a `realpathSync` call along the way to it failed for a
 * reason other than the path not existing.
 *
 * @param {string} target - The path as it was given on the command line.
 * @param {UnresolvablePathError} error - The failure `canonicalize` raised.
 * @returns {void}
 */
function reportUnresolvable(target, error) {
  const code = errnoCode(error.cause);
  console.error(
    `ERR_CLEAN_UNRESOLVABLE: could not verify whether a path is inside the repository: ${target}\n` +
      "Expected: every directory on the way to the target can be resolved with " +
      "`realpath`, or is confirmed absent.\n" +
      `Actual: resolving ${error.at} failed${code === undefined ? "" : ` (${code})`}, ` +
      "which could be hiding a symlink.\n" +
      "Next: make every ancestor directory readable and searchable, then retry; " +
      "do not remove the target until containment can be verified.",
  );
}

/**
 * Remove each target path, refusing anything outside the repository.
 *
 * @remarks
 * Exported so `tests/clean.test.ts` can exercise every branch (no targets, a
 * lexical escape, an escape through a directory symlink) directly, instead of
 * only through a spawned process. `root` defaults to this repository's own
 * root and is overridable so a test can point it at a throwaway `mkdtempSync`
 * directory instead of writing into the real project directory — the same
 * dependency-injection shape `sync-labels.mjs`'s `main` uses for `root`.
 *
 * Every target is judged before any of them is removed: a bad target late in
 * the list must not be preceded by a partial deletion the caller never asked
 * for.
 *
 * @param {readonly string[]} targets - Paths to remove, relative to `root`
 * or already inside it.
 * @param {string} [root] - Directory targets must resolve inside; defaults
 * to this repository's own root.
 * @returns {number} Process exit code: 0 on success, 2 for bad usage.
 */
export function clean(targets, root = repoRoot) {
  if (targets.length === 0) {
    console.error(
      "ERR_CLEAN_NO_TARGETS: no targets given.\n" +
        "Expected: at least one path to remove.\n" +
        "Actual: no arguments.\n" +
        "Next: run `node scripts/clean.mjs <path>...`.",
    );
    return 2;
  }

  /** @type {string} */
  let realRoot;
  try {
    realRoot = canonicalize(root);
  } catch (error) {
    if (!(error instanceof UnresolvablePathError)) {
      throw error;
    }
    reportUnresolvable(root, error);
    return 2;
  }
  /** @type {string[]} */
  const approved = [];

  for (const target of targets) {
    const resolved = path.resolve(root, target);
    if (escapes(root, resolved)) {
      reportRefusal(
        "ERR_CLEAN_OUTSIDE_ROOT",
        target,
        "a path that resolves inside the repository root.",
        `it resolves to ${resolved}.`,
      );
      return 2;
    }

    // Only the parent is canonicalized: resolving the final component too
    // would refuse a symlink that a caller legitimately means to unlink,
    // which `rmSync` does without following it.
    /** @type {string} */
    let real;
    try {
      real = path.join(canonicalize(path.dirname(resolved)), path.basename(resolved));
    } catch (error) {
      if (!(error instanceof UnresolvablePathError)) {
        throw error;
      }
      reportUnresolvable(target, error);
      return 2;
    }
    if (escapes(realRoot, real)) {
      reportRefusal(
        "ERR_CLEAN_SYMLINK_ESCAPE",
        target,
        "a path whose real location, once symlinks are followed, is inside the repository root.",
        `it really lies at ${real}.`,
      );
      return 2;
    }

    approved.push(resolved);
  }

  for (const resolved of approved) {
    rmSync(resolved, { recursive: true, force: true });
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = clean(process.argv.slice(2));
}
