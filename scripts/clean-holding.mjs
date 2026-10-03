#!/usr/bin/env node
// Remove only explicitly named shipping-issues holdings for the origin repository.
// Run with pnpm clean:holding <issue-number|run> [...]. Refuses outside a Git
// repository or without a recognisable origin. No credentials or personal config
// are read. All targets are checked before deleting any; a filesystem change
// between validation and removal is outside this containment check's guarantee.
import { execFileSync } from "node:child_process";
import console from "node:console";
import { lstatSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { canonicalize, escapes } from "./lib/clean-paths.mjs";
import { isolatedGitEnv } from "./lib/git-env.mjs";

/**
 * Report a refusal without exposing an origin URL or an environment value.
 * @param {string} code - Stable cleanup error identifier.
 * @param {string} actual - What prevented this cleanup.
 * @param {string} next - A safe recovery action.
 * @returns {number} Usage/refusal exit status.
 */
function refuse(code, actual, next) {
  console.error(
    `${code}: holding cleanup refused.\n` +
      "Expected: named issue-number or run directories inside this repository's holding area.\n" +
      `Actual: ${actual}\nNext: ${next}`,
  );
  return 2;
}

/**
 * Resolve the same origin slug forms accepted by shipping's preflight.
 * @param {string} root - Repository in which to read origin.
 * @returns {string | undefined} Safe owner/repository slug, when available.
 */
function repositorySlug(root) {
  /** @type {string} */
  let origin;
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      env: isolatedGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
  let slug = origin.replace(/\.git$/u, "");
  if (/^git@[^:]+:/u.test(slug)) {
    slug = slug.slice(slug.indexOf(":") + 1);
  } else if (/^(?:ssh|https?):\/\//u.test(slug)) {
    slug = slug.replace(/^[^:]+:\/\/[^/]+\//u, "");
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(slug)) return undefined;
  if (slug.split("/").some((part) => part === "." || part === "..")) return undefined;
  return slug;
}

/**
 * Remove this repository's selected shipping holdings.
 * @param {readonly string[]} targets - Issue numbers or the literal "run".
 * @param {string} [root] - Repository root; defaults to the calling directory.
 * @returns {number} Zero on success, two on refusal, one on a removal failure.
 */
export function cleanHolding(targets, root = process.cwd()) {
  if (targets.length === 0) {
    return refuse(
      "ERR_CLEAN_NO_TARGETS",
      "no targets given.",
      "Run pnpm clean:holding <issue-number|run> [...].",
    );
  }
  if (targets.some((target) => !/^(?:\d+|run)$/u.test(target))) {
    return refuse(
      "ERR_CLEAN_INVALID_TARGET",
      "a target is not an issue number or run.",
      "Pass issue numbers or run, without paths.",
    );
  }
  const slug = repositorySlug(root);
  if (slug === undefined) {
    return refuse(
      "ERR_CLEAN_REPOSITORY",
      "Git or the origin repository could not be resolved.",
      "Check git remote get-url origin in the intended checkout.",
    );
  }
  const stateOverride = process.env["AGENT_SKILL_STATE_DIR"] ?? "";
  const stateRoot =
    stateOverride === ""
      ? path.join(homedir(), ".local", "state", "agent-skills")
      : stateOverride;
  /** @type {string[]} */
  const approved = [];
  try {
    // Canonicalize only the caller-selected state directory. The repository and
    // holding components must stay below it at their own names; canonicalizing
    // holding as a new trusted root would admit a link into another repository.
    const holding = path.join(
      canonicalize(stateRoot),
      "shipping-issues",
      slug.replace("/", "__"),
      "holding",
    );
    for (const target of targets) {
      const candidate = path.join(holding, target);
      if (escapes(holding, canonicalize(candidate))) {
        return refuse(
          "ERR_CLEAN_SYMLINK_ESCAPE",
          "a target or its ancestor redirects outside the holding area.",
          "Inspect holding symlinks; retain the files until containment can be verified.",
        );
      }
      approved.push(candidate);
    }
  } catch {
    return refuse(
      "ERR_CLEAN_UNRESOLVABLE",
      "a target's real location could not be verified.",
      "Make the state directory and holding ancestors readable and searchable, then retry.",
    );
  }
  for (const target of approved) {
    /** @type {boolean} */
    let existed;
    try {
      existed = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
      rmSync(target, { recursive: true, force: true });
    } catch {
      console.error(
        "ERR_CLEAN_REMOVE_FAILED: could not remove a validated holding.\nExpected: the named holding can be removed.\nActual: the filesystem refused removal; earlier reported removals may have completed.\nNext: inspect filesystem permissions and retain the remaining holdings.",
      );
      return 1;
    }
    console.log(`${existed ? "Removed" : "Already absent"}: ${target}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = cleanHolding(process.argv.slice(2));
}
